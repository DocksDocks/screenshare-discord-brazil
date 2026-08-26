import { createRequire } from "node:module";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

interface GatewayRelay {
  isRoutedHost(host: string): boolean;
  relayPortForExecutable(executable: string): number;
  startGatewayRelay(options: {
    listenPort: number;
    torPort: number;
    torReady: Promise<void>;
    authorizeTor(notBefore: bigint): boolean | Promise<boolean>;
    onRouted(host: string): void;
  }): { server: net.Server; ready: Promise<net.Server> };
}

const require = createRequire(import.meta.url);
const relay = require("../runtime/gateway-relay.cjs") as GatewayRelay;
const servers: net.Server[] = [];

function listen(server: net.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));
}

function read(socket: net.Socket, size: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const buffered = Buffer.concat(chunks);
      if (buffered.length < size) return;
      socket.pause();
      socket.off("data", onData);
      if (buffered.length > size) socket.unshift(buffered.subarray(size));
      resolve(buffered.subarray(0, size));
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.resume();
  });
}

async function beginFrame(socket: net.Socket, frame: Buffer): Promise<{ response: Promise<Buffer> }> {
  socket.write(Buffer.from([5, 1, 0]));
  expect(await read(socket, 2)).toEqual(Buffer.from([5, 0]));
  socket.write(frame);
  return { response: read(socket, 10) };
}

function domainFrame(host: string | Buffer, port = 443): Buffer {
  const encoded = Buffer.isBuffer(host) ? host : Buffer.from(host, "ascii");
  const frame = Buffer.alloc(7 + encoded.length);
  frame.set([5, 1, 0, 3, encoded.length]);
  encoded.copy(frame, 5);
  frame.writeUInt16BE(port, 5 + encoded.length);
  return frame;
}

function beginRequest(socket: net.Socket, host: string, port = 443): Promise<{ response: Promise<Buffer> }> {
  return beginFrame(socket, domainFrame(host, port));
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("gateway relay", () => {
  it("uses isolated ports and recognizes only protected hosts", () => {
    expect(relay.relayPortForExecutable("C:\\Discord\\Discord.exe")).toBe(19060);
    expect(relay.relayPortForExecutable("C:\\DiscordPTB\\DiscordPTB.exe")).toBe(19061);
    expect(relay.isRoutedHost("gateway-us-east1-b.discord.gg")).toBe(true);
    expect(relay.isRoutedHost("gateway.discord.gg.")).toBe(true);
    expect(relay.isRoutedHost("GATEWAY.DISCORD.GG")).toBe(true);
    expect(relay.isRoutedHost("stream.discord.media")).toBe(false);
    expect(relay.isRoutedHost("discord.gg.evil.example")).toBe(false);
    expect(relay.isRoutedHost(".discord.gg")).toBe(false);
    expect(relay.isRoutedHost("gateway..discord.gg")).toBe(false);
    expect(relay.isRoutedHost("gateway/discord.gg")).toBe(false);
    expect(relay.isRoutedHost("gateway .discord.gg")).toBe(false);
    expect(relay.isRoutedHost(`${"a".repeat(64)}.discord.gg`)).toBe(false);
    expect(relay.isRoutedHost(`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`)).toBe(false);
  });

  it("holds a gateway socket until Tor is ready and rejects other destinations", async () => {
    const tor = net.createServer((socket) => {
      void (async () => {
        expect(await read(socket, 3)).toEqual(Buffer.from([5, 1, 0]));
        socket.write(Buffer.from([5, 0]));
        const header = await read(socket, 5);
        const hostLength = header[4];
        const rest = await read(socket, hostLength + 2);
        expect(rest.subarray(0, hostLength).toString("ascii")).toBe("gateway.discord.gg");
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 1]));
        socket.pipe(socket);
      })();
    });
    const torPort = await listen(tor);
    let releaseTor!: () => void;
    const torReady = new Promise<void>((resolve) => {
      releaseTor = resolve;
    });
    const routed: string[] = [];
    const gateway = relay.startGatewayRelay({
      listenPort: 0,
      torPort,
      torReady,
      authorizeTor: () => true,
      onRouted: (host) => routed.push(host),
    });
    servers.push(gateway.server);
    await gateway.ready;
    const relayPort = (gateway.server.address() as net.AddressInfo).port;

    const rejected = net.createConnection({ host: "127.0.0.1", port: relayPort });
    expect((await (await beginRequest(rejected, "discord.com")).response)[1]).not.toBe(0);
    rejected.destroy();

    const client = net.createConnection({ host: "127.0.0.1", port: relayPort });
    const pending = await beginRequest(client, "gateway.discord.gg");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(routed).toEqual([]);

    releaseTor();
    expect(await pending.response).toEqual(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
    client.write("held");
    expect((await read(client, 4)).toString()).toBe("held");
    expect(routed).toEqual(["gateway.discord.gg"]);
    client.destroy();
  });

  it("rejects a protected connection when the Tor listener is not owned", async () => {
    const gateway = relay.startGatewayRelay({
      listenPort: 0,
      torPort: 9,
      torReady: Promise.resolve(),
      authorizeTor: () => false,
      onRouted: () => {
        throw new Error("an unauthorized route was reported as ready");
      },
    });
    servers.push(gateway.server);
    await gateway.ready;
    const relayPort = (gateway.server.address() as net.AddressInfo).port;
    const client = net.createConnection({ host: "127.0.0.1", port: relayPort });
    expect((await (await beginRequest(client, "gateway.discord.gg")).response)[1]).toBe(1);
    client.destroy();
  });

  it("rejects malformed DNS names, non-443 ports, and IP address targets before Tor authorization", async () => {
    const gateway = relay.startGatewayRelay({
      listenPort: 0,
      torPort: 9,
      torReady: Promise.resolve(),
      authorizeTor: () => {
        throw new Error("malformed traffic reached Tor authorization");
      },
      onRouted: () => {
        throw new Error("malformed traffic was routed");
      },
    });
    servers.push(gateway.server);
    await gateway.ready;
    const relayPort = (gateway.server.address() as net.AddressInfo).port;
    const invalidFrames = [
      domainFrame(".discord.gg"),
      domainFrame("gateway..discord.gg"),
      domainFrame("gateway/discord.gg"),
      domainFrame("gateway .discord.gg"),
      domainFrame(`${"a".repeat(64)}.discord.gg`),
      domainFrame(`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`),
      domainFrame(Buffer.concat([Buffer.from([0xff]), Buffer.from(".discord.gg", "ascii")])),
      domainFrame("gateway.discord.gg", 80),
      Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 1, 187]),
      Buffer.from([5, 1, 0, 4, ...Buffer.alloc(16), 1, 187]),
      Buffer.from([5, 1, 1, 9]),
    ];
    for (const frame of invalidFrames) {
      const client = net.createConnection({ host: "127.0.0.1", port: relayPort });
      expect((await (await beginFrame(client, frame)).response)[1]).toBe(2);
      client.destroy();
    }
  });

  it("fails closed when Tor ownership changes after upstream connection", async () => {
    const tor = net.createServer((socket) => {
      void (async () => {
        await read(socket, 3);
        socket.write(Buffer.from([5, 0]));
        const header = await read(socket, 5);
        await read(socket, header[4] + 2);
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 1]));
      })();
    });
    const torPort = await listen(tor);
    let ownershipChecks = 0;
    const gateway = relay.startGatewayRelay({
      listenPort: 0,
      torPort,
      torReady: Promise.resolve(),
      authorizeTor: async () => ++ownershipChecks === 1,
      onRouted: () => {
        throw new Error("a changed Tor owner was routed");
      },
    });
    servers.push(gateway.server);
    await gateway.ready;
    const client = net.createConnection({ host: "127.0.0.1", port: (gateway.server.address() as net.AddressInfo).port });
    expect((await (await beginRequest(client, "gateway.discord.gg")).response)[1]).toBe(1);
    expect(ownershipChecks).toBe(2);
    client.destroy();
  });

  it("refuses to start when its relay port is already owned", async () => {
    const occupied = net.createServer();
    const port = await listen(occupied);
    const gateway = relay.startGatewayRelay({
      listenPort: port,
      torPort: 9,
      torReady: Promise.resolve(),
      authorizeTor: () => true,
      onRouted: () => undefined,
    });
    await expect(gateway.ready).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});
