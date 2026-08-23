import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { listContainedFiles, resolveContainedFile } = require("../runtime/runtime-safety.cjs");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const torRoot = path.join(projectRoot, "vendor", "tor");
const torExe = path.join(torRoot, "tor", "tor.exe");
const manifestPath = path.join(projectRoot, "vendor", "tor-manifest.json");
const targetHost = "gateway.discord.gg";
const socksPort = Number(process.env.GOLIVE_TOR_PROBE_PORT ?? "19060");

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function verifyBundle() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (
    manifest?.schema !== 1 ||
    manifest.files === null ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files) ||
    typeof manifest.files["tor/tor.exe"] !== "string"
  ) {
    throw new Error("invalid Tor manifest");
  }
  const listedFiles = Object.keys(manifest.files).sort();
  const actualFiles = listContainedFiles(torRoot).sort();
  if (listedFiles.length !== actualFiles.length || listedFiles.some((name, index) => name !== actualFiles[index])) {
    throw new Error("Tor bundle contains files outside its manifest");
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = resolveContainedFile(torRoot, name);
    if (
      typeof expected !== "string" ||
      !/^[a-f0-9]{64}$/i.test(expected) ||
      !fs.existsSync(file) ||
      !fs.statSync(file).isFile() ||
      sha256(file) !== expected.toLowerCase()
    ) {
      throw new Error("Tor bundle integrity check failed");
    }
  }
}

function waitForBootstrap(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Tor bootstrap timed out")), 120_000);
    const onData = (chunk) => {
      output = `${output}${chunk}`.slice(-16_384);
      if (output.includes("Bootstrapped 100%")) finish();
    };
    const onExit = (code) => finish(new Error(`Tor exited before bootstrap (${code ?? "unknown"})`));
    const onError = () => finish(new Error("Tor could not be started"));
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.stdout.resume();
      child.stderr.resume();
      if (error) reject(error);
      else resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function openSocksTunnel(port, hostname) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let buffer = Buffer.alloc(0);
    let state = "greeting";
    let settled = false;
    const timer = setTimeout(() => fail(new Error("SOCKS5 handshake timed out")), 20_000);

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };

    socket.once("error", fail);
    socket.once("close", () => fail(new Error("SOCKS5 connection closed early")));
    socket.once("connect", () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (state === "greeting") {
        if (buffer.length < 2) return;
        if (buffer[0] !== 0x05 || buffer[1] !== 0x00) return fail(new Error("SOCKS5 authentication refused"));
        buffer = buffer.subarray(2);
        const host = Buffer.from(hostname, "ascii");
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, Buffer.from([0x01, 0xbb])]));
        state = "connect";
      }
      if (state === "connect") {
        if (buffer.length < 5) return;
        const addressLength = buffer[3] === 0x01 ? 4 : buffer[3] === 0x04 ? 16 : buffer[3] === 0x03 ? 1 + buffer[4] : -1;
        if (addressLength < 0) return fail(new Error("SOCKS5 returned an unknown address type"));
        const responseLength = 4 + addressLength + 2;
        if (buffer.length < responseLength) return;
        if (buffer[0] !== 0x05 || buffer[1] !== 0x00 || buffer[2] !== 0x00) {
          return fail(new Error(`SOCKS5 connect failed (${buffer[1]})`));
        }
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners("data");
        socket.removeAllListeners("close");
        socket.removeListener("error", fail);
        resolve(socket);
      }
    });
  });
}

function verifyTls(socket, hostname) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const secureSocket = tls.connect({ socket, servername: hostname, rejectUnauthorized: true, minVersion: "TLSv1.2" }, () => {
      finish();
      secureSocket.destroy();
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      secureSocket.removeListener("error", onError);
      secureSocket.removeListener("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error("TLS connection closed before authentication"));
    timer = setTimeout(() => secureSocket.destroy(new Error("TLS handshake timed out")), 20_000);
    secureSocket.once("error", onError);
    secureSocket.once("close", onClose);
  });
}

async function waitBounded(promise, milliseconds) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(resolve, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopTor(child) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  let didExit = false;
  const exited = new Promise((resolve) =>
    child.once("exit", () => {
      didExit = true;
      resolve();
    }),
  );
  child.kill();
  await waitBounded(exited, 5_000);
  if (!didExit && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await waitBounded(exited, 5_000);
  }
  if (!didExit && child.exitCode === null && child.signalCode === null) throw new Error("Tor probe process did not stop");
}

if (!Number.isSafeInteger(socksPort) || socksPort < 1024 || socksPort > 65_535) {
  throw new Error("GOLIVE_TOR_PROBE_PORT must be an unprivileged TCP port");
}

verifyBundle();
const work = fs.mkdtempSync(path.join(os.tmpdir(), "golive-tor-probe-"));
const emptyTorrc = path.join(work, "torrc");
let child;

try {
  fs.writeFileSync(emptyTorrc, "");
  child = spawn(
    torExe,
    [
      "-f",
      emptyTorrc,
      "--SocksPort",
      `127.0.0.1:${socksPort}`,
      "--DataDirectory",
      path.join(work, "data"),
      "--GeoIPFile",
      path.join(torRoot, "data", "geoip"),
      "--GeoIPv6File",
      path.join(torRoot, "data", "geoip6"),
      "--ClientOnly",
      "1",
      "--ExcludeExitNodes",
      "{br}",
      "--GeoIPExcludeUnknown",
      "1",
      "--SocksPolicy",
      "accept 127.0.0.1",
      "--SocksPolicy",
      "reject *",
      "--NoExec",
      "1",
      "--SafeLogging",
      "1",
      "--Log",
      "notice stdout",
      "--__OwningControllerProcess",
      String(process.pid),
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  await waitForBootstrap(child);
  const socket = await openSocksTunnel(socksPort, targetHost);
  await verifyTls(socket, targetHost);
  console.log(`[tor-probe] verified SOCKS5 and TLS to ${targetHost}`);
} finally {
  try {
    if (child !== undefined) await stopTor(child);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
