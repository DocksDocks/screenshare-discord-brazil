"use strict";

const net = require("node:net");
const path = require("node:path");
const tls = require("node:tls");

function isRoutedHost(host) {
  const lower = String(host).toLowerCase();
  const normalized = lower.endsWith(".") ? lower.slice(0, -1) : lower;
  return normalized === "discord.gg" || normalized.endsWith(".discord.gg");
}

function relayPortForExecutable(executable) {
  const name = path.basename(executable).toLowerCase();
  if (name === "discordptb.exe") return 19061;
  if (name === "discordcanary.exe") return 19062;
  if (name === "discorddevelopment.exe") return 19063;
  return 19060;
}

function readFrame(socket, frameSize) {
  return new Promise((resolve) => {
    let buffered = Buffer.alloc(0);
    let settled = false;

    const finish = (frame) => {
      if (settled) return;
      settled = true;
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
      resolve(frame);
    };
    const onClose = () => finish(null);
    const onError = () => finish(null);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const size = frameSize(buffered);
      if (size < 0 || buffered.length < size) return;
      socket.pause();
      if (buffered.length > size) socket.unshift(buffered.subarray(size));
      finish(buffered.subarray(0, size));
    };

    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
    socket.resume();
  });
}

function socksFrameSize(buffer) {
  if (buffer.length < 4) return -1;
  if (buffer[3] === 1) return 10;
  if (buffer[3] === 4) return 22;
  if (buffer[3] === 3) return buffer.length < 5 ? -1 : 7 + buffer[4];
  return 4;
}

function domainRequest(host, port) {
  const encoded = Buffer.from(host, "ascii");
  if (encoded.length === 0 || encoded.length > 255) throw new Error("invalid_socks_target");
  const request = Buffer.alloc(7 + encoded.length);
  request.set([5, 1, 0, 3, encoded.length]);
  encoded.copy(request, 5);
  request.writeUInt16BE(port, 5 + encoded.length);
  return request;
}

function parseDomainRequest(request) {
  if (request === null || request[0] !== 5 || request[1] !== 1 || request[2] !== 0 || request[3] !== 3) return null;
  const length = request[4];
  if (length === 0) return null;
  const lower = request.subarray(5, 5 + length).toString("ascii").toLowerCase();
  return {
    host: lower.endsWith(".") ? lower.slice(0, -1) : lower,
    port: request.readUInt16BE(5 + length),
  };
}

function connect(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.off("connect", onConnect);
      if (result === null) socket.destroy();
      resolve(result);
    };
    const onConnect = () => finish(socket);
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.once("connect", onConnect);
    socket.once("error", () => finish(null));
  });
}

async function openSocks5Tunnel(proxyPort, host, port, timeoutMs) {
  const socket = await connect(proxyPort, "127.0.0.1", timeoutMs);
  if (socket === null) return null;
  socket.setTimeout(timeoutMs, () => socket.destroy());

  try {
    const greetingReply = readFrame(socket, (buffer) => (buffer.length < 2 ? -1 : 2));
    socket.write(Buffer.from([5, 1, 0]));
    const greeting = await greetingReply;
    if (greeting === null || greeting[0] !== 5 || greeting[1] !== 0) throw new Error("socks_auth_failed");

    const tunnelReply = readFrame(socket, socksFrameSize);
    socket.write(domainRequest(host, port));
    const reply = await tunnelReply;
    if (reply === null || reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0 || ![1, 3, 4].includes(reply[3])) {
      throw new Error("socks_connect_failed");
    }
    socket.setTimeout(0);
    return socket;
  } catch {
    socket.destroy();
    return null;
  }
}

async function probeSocks5Tls(proxyPort, host, timeoutMs) {
  const socket = await openSocks5Tunnel(proxyPort, host, 443, timeoutMs);
  if (socket === null) return false;

  return new Promise((resolve) => {
    const secure = tls.connect({ socket, servername: host, rejectUnauthorized: true });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      secure.destroy();
      resolve(result);
    };
    secure.setTimeout(timeoutMs, () => finish(false));
    secure.once("secureConnect", () => finish(secure.authorized));
    secure.once("error", () => finish(false));
    secure.once("close", () => finish(false));
  });
}

function startGatewayRelay({ listenPort, torPort, torReady, authorizeTor, onRouted }) {
  const server = net.createServer((client) => {
    client.on("error", () => client.destroy());
    client.setTimeout(120_000, () => client.destroy());
    void (async () => {
      const greeting = await readFrame(client, (buffer) => (buffer.length < 2 ? -1 : 2 + buffer[1]));
      if (greeting === null || greeting[0] !== 5 || !greeting.subarray(2).includes(0)) return client.destroy();
      client.write(Buffer.from([5, 0]));

      const request = parseDomainRequest(await readFrame(client, socksFrameSize));
      if (request === null || request.port !== 443 || !isRoutedHost(request.host)) {
        client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
        return;
      }

      await torReady;
      if (client.destroyed) return;
      if (!(await authorizeTor(process.hrtime.bigint()))) {
        client.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]));
        return;
      }
      if (client.destroyed) return;
      const upstream = await openSocks5Tunnel(torPort, request.host, request.port, 15_000);
      if (upstream === null || client.destroyed) {
        upstream?.destroy();
        if (!client.destroyed) client.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]));
        return;
      }
      if (!(await authorizeTor(process.hrtime.bigint()))) {
        upstream.destroy();
        client.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]));
        return;
      }
      if (client.destroyed) {
        upstream.destroy();
        return;
      }

      client.setTimeout(0);
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
      client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      onRouted(request.host);
      upstream.pipe(client);
      client.pipe(upstream);
    })().catch(() => client.destroy());
  });

  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => resolve(server));
  });
  return { server, ready };
}

module.exports = {
  isRoutedHost,
  openSocks5Tunnel,
  probeSocks5Tls,
  relayPortForExecutable,
  startGatewayRelay,
};
