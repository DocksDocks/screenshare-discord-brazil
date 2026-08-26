"use strict";

const { execFile } = require("node:child_process");
const dgram = require("node:dgram");
const dns = require("node:dns");
const dnsPromises = require("node:dns/promises");
const fs = require("node:fs");
const http = require("node:http");
const http2 = require("node:http2");
const https = require("node:https");
const net = require("node:net");
const { syncBuiltinESMExports } = require("node:module");
const path = require("node:path");
const tls = require("node:tls");
const { URL } = require("node:url");

const POWERSHELL = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function resolveContainedFile(root, name) {
  if (typeof name !== "string" || name.length === 0 || name.includes("\0")) {
    throw new Error("invalid runtime path");
  }
  const portableName = name.replaceAll("\\", "/");
  const segments = portableName.split("/");
  if (
    portableName.startsWith("/") ||
    /^[a-z]:/i.test(portableName) ||
    segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes(":"))
  ) {
    throw new Error("invalid runtime path");
  }
  const resolvedRoot = path.resolve(root);
  if (fs.lstatSync(resolvedRoot).isSymbolicLink()) throw new Error("runtime root links are not allowed");
  const file = path.resolve(resolvedRoot, ...segments);
  const physicalRoot = fs.realpathSync.native(resolvedRoot);
  const physicalFile = fs.realpathSync.native(file);
  const relative = path.relative(physicalRoot, physicalFile);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("runtime path escapes its root");
  }
  return physicalFile;
}

function listContainedFiles(root, current = root) {
  if (fs.lstatSync(path.resolve(root)).isSymbolicLink()) throw new Error("runtime root links are not allowed");
  return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) throw new Error("runtime links are not allowed");
    const file = path.join(current, entry.name);
    const name = path.relative(root, file).replaceAll("\\", "/");
    resolveContainedFile(root, name);
    if (entry.isDirectory()) return listContainedFiles(root, file);
    if (entry.isFile()) return [name];
    throw new Error("unsupported runtime entry");
  });
}

let processIdentityQueue = Promise.resolve();

function queryProcessIdentity(script) {
  const request = processIdentityQueue.then(
    () =>
      new Promise((resolve) => {
        execFile(
          POWERSHELL,
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
          { encoding: "utf8", windowsHide: true, timeout: 10_000 },
          (error, stdout) => resolve(error === null ? stdout.trim() : ""),
        );
      }),
  );
  processIdentityQueue = request.then(
    () => undefined,
    () => undefined,
  );
  return request;
}

function encodedPowerShellValue(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

async function processMatchesExecutable(pid, expectedExecutable) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof expectedExecutable !== "string") return false;
  const script = [
    `$expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPowerShellValue(expectedExecutable)}'))`,
    `$candidate = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
    "if ($null -ne $candidate -and $null -ne $candidate.ExecutablePath -and [String]::Equals([IO.Path]::GetFullPath($candidate.ExecutablePath), [IO.Path]::GetFullPath($expected), [StringComparison]::OrdinalIgnoreCase)) { [Console]::Out.Write('1') }",
  ].join("; ");
  return (await queryProcessIdentity(script)) === "1";
}

async function processOwnsLoopbackTcpListener(pid, expectedExecutable, port) {
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof expectedExecutable !== "string" ||
    !Number.isSafeInteger(port) ||
    port <= 0 ||
    port > 65_535
  ) {
    return false;
  }
  const script = [
    `$expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPowerShellValue(expectedExecutable)}'))`,
    `$candidate = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
    `$listener = Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort ${port} -OwningProcess ${pid} -ErrorAction SilentlyContinue`,
    "if ($null -ne $candidate -and $null -ne $listener -and $null -ne $candidate.ExecutablePath -and [String]::Equals([IO.Path]::GetFullPath($candidate.ExecutablePath), [IO.Path]::GetFullPath($expected), [StringComparison]::OrdinalIgnoreCase)) { [Console]::Out.Write('1') }",
  ].join("; ");
  return (await queryProcessIdentity(script)) === "1";
}

function isProtectedHostname(host) {
  if (typeof host !== "string") return false;
  const normalized = host.trim().toLowerCase().replace(/\.+$/, "");
  return normalized === "discord.gg" || normalized.endsWith(".discord.gg");
}

function withoutPort(host) {
  const trimmed = host.trim();
  const match = /^(.+):(\d+)$/.exec(trimmed);
  return match !== null && !match[1].includes(":") ? match[1] : trimmed;
}

function optionsHostname(options) {
  if (options === null || typeof options !== "object") return null;
  if (typeof options.hostname === "string" && options.hostname.length > 0) return withoutPort(options.hostname);
  return typeof options.host === "string" && options.host.length > 0 ? withoutPort(options.host) : null;
}

function urlHostname(input) {
  try {
    if (input instanceof URL || typeof input === "string") return new URL(input).hostname;
    if (input !== null && typeof input === "object" && typeof input.url === "string") {
      return new URL(input.url).hostname;
    }
  } catch {
    return null;
  }
  return null;
}

function netHostname(args) {
  const options = args[0];
  if (options !== null && typeof options === "object") {
    if (typeof options.path === "string") return null;
    return optionsHostname(options);
  }
  return typeof options === "number" && typeof args[1] === "string" ? withoutPort(args[1]) : null;
}

function tlsHostname(args) {
  const first = args[0];
  let options = first !== null && typeof first === "object" ? first : null;
  let positionalHost = null;
  if (typeof first === "number") {
    if (typeof args[1] === "string") {
      positionalHost = withoutPort(args[1]);
      options = args[2] !== null && typeof args[2] === "object" ? args[2] : null;
    } else {
      options = args[1] !== null && typeof args[1] === "object" ? args[1] : null;
    }
  }
  const optionHost = optionsHostname(options);
  const servername = typeof options?.servername === "string" ? withoutPort(options.servername) : null;
  for (const candidate of [optionHost, positionalHost, servername]) {
    if (isProtectedHostname(candidate)) return candidate;
  }
  if (options?.socket || typeof options?.path === "string") return null;
  return optionHost ?? positionalHost ?? servername;
}

function requestHostname(args) {
  const first = args[0];
  const hasUrl = first instanceof URL || typeof first === "string";
  const options = hasUrl ? args[1] : first;
  if (options !== null && typeof options === "object" && typeof options.socketPath === "string") return null;
  return optionsHostname(options) ?? (hasUrl ? urlHostname(first) : null);
}

function datagramHostname(args) {
  if (typeof args[2] === "string") return withoutPort(args[2]);
  if (typeof args[4] === "string") return withoutPort(args[4]);
  return null;
}

function assertNodeTargetAllowed(host) {
  if (!isProtectedHostname(host)) return;
  const error = new Error("protected_host_node_network_blocked");
  error.code = "ERR_GOLIVE_PROTECTED_HOST";
  throw error;
}

function guarded(original, hostname) {
  return function (...args) {
    assertNodeTargetAllowed(hostname(args));
    return Reflect.apply(original, this, args);
  };
}

function guardedWebSocket(original) {
  const GuardedWebSocket = new Proxy(original, {
    construct(target, args, newTarget) {
      const normalizedArgs = [...args];
      if (normalizedArgs.length > 0) {
        const parsed = new URL(normalizedArgs[0]);
        normalizedArgs[0] = parsed.href;
        assertNodeTargetAllowed(parsed.hostname);
      }
      return Reflect.construct(target, normalizedArgs, newTarget);
    },
  });
  Object.defineProperty(original.prototype, "constructor", {
    ...Object.getOwnPropertyDescriptor(original.prototype, "constructor"),
    value: GuardedWebSocket,
  });
  return GuardedWebSocket;
}

let nodeNetworkGuardsInstalled = false;
function installNodeNetworkGuards() {
  if (nodeNetworkGuardsInstalled) return;
  nodeNetworkGuardsInstalled = true;

  net.connect = guarded(net.connect, netHostname);
  net.createConnection = guarded(net.createConnection, netHostname);
  net.Socket.prototype.connect = guarded(net.Socket.prototype.connect, netHostname);
  dgram.Socket.prototype.connect = guarded(dgram.Socket.prototype.connect, (args) =>
    typeof args[1] === "string" ? withoutPort(args[1]) : null,
  );
  dgram.Socket.prototype.send = guarded(dgram.Socket.prototype.send, datagramHostname);
  tls.connect = guarded(tls.connect, tlsHostname);
  http.request = guarded(http.request, requestHostname);
  http.get = guarded(http.get, requestHostname);
  https.request = guarded(https.request, requestHostname);
  https.get = guarded(https.get, requestHostname);
  http2.connect = guarded(http2.connect, (args) => urlHostname(args[0]));

  const dnsMethods = [
    "lookup",
    "resolve",
    "resolve4",
    "resolve6",
    "resolveAny",
    "resolveCaa",
    "resolveCname",
    "resolveMx",
    "resolveNaptr",
    "resolveNs",
    "resolvePtr",
    "resolveSoa",
    "resolveSrv",
    "resolveTlsa",
    "resolveTxt",
  ];
  for (const target of [dns, dnsPromises, dns.Resolver.prototype, dnsPromises.Resolver.prototype]) {
    for (const name of dnsMethods) {
      const original = target[name];
      if (typeof original !== "function") continue;
      const guardedDnsMethod = function (host, ...args) {
        assertNodeTargetAllowed(host);
        return Reflect.apply(original, this, [host, ...args]);
      };
      for (const symbol of Object.getOwnPropertySymbols(original)) {
        Object.defineProperty(guardedDnsMethod, symbol, Object.getOwnPropertyDescriptor(original, symbol));
      }
      target[name] = guardedDnsMethod;
    }
  }
  if (typeof globalThis.fetch === "function") {
    const NativeRequest = globalThis.Request;
    globalThis.fetch = guarded(globalThis.fetch, (args) => {
      try {
        return typeof NativeRequest === "function"
          ? urlHostname(new NativeRequest(args[0], args[1]))
          : urlHostname(args[0]);
      } catch {
        return urlHostname(args[0]);
      }
    });
  }
  if (typeof globalThis.WebSocket === "function") {
    globalThis.WebSocket = guardedWebSocket(globalThis.WebSocket);
  }
  syncBuiltinESMExports();
}

module.exports = {
  installNodeNetworkGuards,
  isProtectedHostname,
  listContainedFiles,
  processMatchesExecutable,
  processOwnsLoopbackTcpListener,
  resolveContainedFile,
};
