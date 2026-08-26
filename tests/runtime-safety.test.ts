import { createRequire, syncBuiltinESMExports } from "node:module";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

interface RuntimeSafety {
  installNodeNetworkGuards(): void;
  isProtectedHostname(host: string): boolean;
  listContainedFiles(root: string): string[];
  processMatchesExecutable(pid: number, expectedExecutable: string): Promise<boolean>;
  processOwnsLoopbackTcpListener(pid: number, expectedExecutable: string, port: number): Promise<boolean>;
  resolveContainedFile(root: string, name: string): string;
}

const require = createRequire(import.meta.url);
const safety = require("../runtime/runtime-safety.cjs") as RuntimeSafety;

describe("runtime safety", () => {
  it("resolves only files below the declared root", () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "golive-runtime-safety-test-"));
    const root = path.join(sandbox, "root");
    const outside = path.join(sandbox, "outside");
    fs.mkdirSync(path.join(root, "tor"), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(root, "tor", "tor.exe"), "tor");
    fs.writeFileSync(path.join(outside, "outside.txt"), "outside");
    fs.symlinkSync(outside, path.join(root, "link"), "junction");
    const rootLink = path.join(sandbox, "root-link");
    fs.symlinkSync(root, rootLink, "junction");
    try {
      expect(safety.resolveContainedFile(root, "tor/tor.exe")).toBe(fs.realpathSync.native(path.join(root, "tor", "tor.exe")));
      expect(() => safety.resolveContainedFile(root, "../outside.txt")).toThrow();
      expect(() => safety.resolveContainedFile(root, "C:\\Windows\\System32\\kernel32.dll")).toThrow();
      expect(() => safety.resolveContainedFile(root, "link/outside.txt")).toThrow();
      expect(() => safety.listContainedFiles(root)).toThrow();
      expect(() => safety.resolveContainedFile(rootLink, "tor/tor.exe")).toThrow();
      expect(() => safety.listContainedFiles(rootLink)).toThrow();
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("matches a PID only to its actual executable without synchronous PowerShell", async () => {
    const source = fs.readFileSync(path.resolve("runtime", "runtime-safety.cjs"), "utf8");
    expect(source).not.toContain("execFileSync");
    expect(source).toContain("processIdentityQueue = request.then(");
    expect(safety.processMatchesExecutable(process.pid, process.execPath)).toBeInstanceOf(Promise);
    expect(await safety.processMatchesExecutable(process.pid, process.execPath)).toBe(true);
    expect(await safety.processMatchesExecutable(process.pid, path.join(os.tmpdir(), "not-node.exe"))).toBe(false);
    expect(await safety.processMatchesExecutable(-1, process.execPath)).toBe(false);
  });

  it("matches a loopback listener to both its PID and executable", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const owned = safety.processOwnsLoopbackTcpListener(process.pid, process.execPath, port);
      expect(owned).toBeInstanceOf(Promise);
      expect(await owned).toBe(true);
      expect(await safety.processOwnsLoopbackTcpListener(process.pid, path.join(os.tmpdir(), "not-node.exe"), port)).toBe(false);
      expect(await safety.processOwnsLoopbackTcpListener(process.pid, process.execPath, port + 1)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("blocks protected hosts across CommonJS and ESM Node networking", async () => {
    const originals = {
      fetch: globalThis.fetch,
      webSocket: globalThis.WebSocket,
      datagramConnect: dgram.Socket.prototype.connect,
      datagramSend: dgram.Socket.prototype.send,
      dnsLookup: dns.lookup,
      dnsResolve4: dns.resolve4,
      dnsPromiseLookup: dnsPromises.lookup,
      httpGet: http.get,
      httpRequest: http.request,
      http2Connect: http2.connect,
      httpsGet: https.get,
      httpsRequest: https.request,
      netConnect: net.connect,
      netCreateConnection: net.createConnection,
      socketConnect: net.Socket.prototype.connect,
      tlsConnect: tls.connect,
    };
    const assertBlocked = (operation: () => unknown) => {
      try {
        operation();
        throw new Error("protected operation was allowed");
      } catch (error) {
        expect(error).toMatchObject({ code: "ERR_GOLIVE_PROTECTED_HOST" });
      }
    };

    try {
      safety.installNodeNetworkGuards();
      expect(safety.isProtectedHostname("discord.gg")).toBe(true);
      expect(safety.isProtectedHostname("gateway-us-east1-b.discord.gg.")).toBe(true);
      expect(safety.isProtectedHostname(" gateway.discord.gg.. ")).toBe(true);
      expect(safety.isProtectedHostname("discord.gg.evil.example")).toBe(false);

      assertBlocked(() => net.connect(443, "gateway.discord.gg"));
      assertBlocked(() => net.createConnection({ host: "gateway.discord.gg", port: 443 }));
      assertBlocked(() => new net.Socket().connect({ host: "gateway.discord.gg", port: 443 }));
      assertBlocked(() => tls.connect({ host: "gateway.discord.gg", port: 443 }));
      assertBlocked(() => http.request("http://gateway.discord.gg"));
      assertBlocked(() => http.get({ hostname: "gateway.discord.gg" }));
      assertBlocked(() => https.request(new URL("https://gateway.discord.gg")));
      assertBlocked(() => https.get({ host: "gateway.discord.gg:443" }));
      assertBlocked(() => globalThis.fetch("https://gateway.discord.gg"));
      const spoofedRequest = new Request("https://gateway.discord.gg");
      Object.defineProperty(spoofedRequest, "url", { value: "https://example.com" });
      assertBlocked(() => globalThis.fetch(spoofedRequest));
      assertBlocked(() => http2.connect("https://gateway.discord.gg"));
      assertBlocked(() => dns.lookup("gateway.discord.gg", () => undefined));
      assertBlocked(() => dns.resolve4("gateway.discord.gg", () => undefined));
      assertBlocked(() => dnsPromises.lookup("gateway.discord.gg"));
      assertBlocked(() => new dns.Resolver().resolve4("gateway.discord.gg", () => undefined));
      assertBlocked(() => new dnsPromises.Resolver().resolve4("gateway.discord.gg"));
      await expect(promisify(dns.lookup)("localhost")).resolves.toMatchObject({
        address: expect.any(String),
        family: expect.any(Number),
      });
      if (typeof globalThis.WebSocket === "function") {
        assertBlocked(() => new globalThis.WebSocket("wss://gateway.discord.gg"));
        assertBlocked(() => new globalThis.WebSocket(new String("wss://gateway.discord.gg") as unknown as string));
        expect(Object.getPrototypeOf(globalThis.WebSocket)).not.toBe(originals.webSocket);
        expect(Object.getPrototypeOf(globalThis.WebSocket.prototype)).not.toBe(originals.webSocket.prototype);
        expect(globalThis.WebSocket.prototype.constructor).toBe(globalThis.WebSocket);
        expect(typeof globalThis.WebSocket.prototype.addEventListener).toBe("function");

        const server = net.createServer((socket) => socket.destroy());
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
          const port = (server.address() as net.AddressInfo).port;
          class DerivedWebSocket extends globalThis.WebSocket {}
          const socket = new DerivedWebSocket(`ws://127.0.0.1:${port}`);
          expect(socket).toBeInstanceOf(DerivedWebSocket);
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("WebSocket did not reject the closed connection")), 3_000);
            socket.addEventListener(
              "error",
              () => {
                clearTimeout(timeout);
                resolve();
              },
              { once: true },
            );
          });
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }

      const datagram = dgram.createSocket("udp4");
      assertBlocked(() => datagram.connect(443, "gateway.discord.gg"));
      assertBlocked(() => datagram.send(Buffer.from("test"), 443, "gateway.discord.gg"));
      datagram.close();

      const [esmHttp, esmHttps, esmNet, esmTls] = await Promise.all([
        import("node:http"),
        import("node:https"),
        import("node:net"),
        import("node:tls"),
      ]);
      assertBlocked(() => esmHttp.request("http://gateway.discord.gg"));
      assertBlocked(() => esmHttps.get("https://gateway.discord.gg"));
      assertBlocked(() => esmNet.connect(443, "gateway.discord.gg"));
      assertBlocked(() => esmTls.connect(443, "gateway.discord.gg"));

      assertBlocked(() => tls.connect({ socket: new net.Socket(), servername: "gateway.discord.gg" }));
      const local = net.createConnection({ host: "127.0.0.1", port: 9 });
      local.on("error", () => undefined);
      local.destroy();
    } finally {
      globalThis.fetch = originals.fetch;
      globalThis.WebSocket = originals.webSocket;
      if (typeof originals.webSocket === "function") {
        Object.defineProperty(originals.webSocket.prototype, "constructor", {
          ...Object.getOwnPropertyDescriptor(originals.webSocket.prototype, "constructor"),
          value: originals.webSocket,
        });
      }
      dgram.Socket.prototype.connect = originals.datagramConnect;
      dgram.Socket.prototype.send = originals.datagramSend;
      dns.lookup = originals.dnsLookup;
      dns.resolve4 = originals.dnsResolve4;
      dnsPromises.lookup = originals.dnsPromiseLookup;
      http.get = originals.httpGet;
      http.request = originals.httpRequest;
      http2.connect = originals.http2Connect;
      https.get = originals.httpsGet;
      https.request = originals.httpsRequest;
      net.connect = originals.netConnect;
      net.createConnection = originals.netCreateConnection;
      net.Socket.prototype.connect = originals.socketConnect;
      tls.connect = originals.tlsConnect;
      syncBuiltinESMExports();
    }
  });
});
