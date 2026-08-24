"use strict";

const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { app, session } = require("electron");
const { probeSocks5Tls, relayPortForExecutable, startGatewayRelay } = require("./gateway-relay.cjs");
const {
  listContainedFiles,
  processMatchesExecutable,
  processOwnsLoopbackTcpListener,
  resolveContainedFile,
} = require("./runtime-safety.cjs");

const TOR_PORT = 9060;
const runtimeDir = __dirname;
const dataRoot = path.dirname(runtimeDir);
const stateDir = path.join(dataRoot, "tor-state");
const pidPath = path.join(stateDir, "tor.pid");
const torExe = path.join(runtimeDir, "tor", "tor", "tor.exe");
const relayPort = relayPortForExecutable(process.execPath);
const pacTemplate = fs.readFileSync(path.join(runtimeDir, "proxy.pac"), "utf8");
if (!pacTemplate.includes("__GATEWAY_RELAY_PORT__")) throw new Error("runtime_integrity_failed");
const pacText = pacTemplate.replaceAll("__GATEWAY_RELAY_PORT__", String(relayPort));
const pacUrl = `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pacText).toString("base64")}`;

// Chromium receives the fail-closed route before Discord's original main module can create a session.
app.commandLine.appendSwitch("proxy-pac-url", pacUrl);

function log(code) {
  try {
    fs.appendFileSync(path.join(dataRoot, "runtime.log"), `${new Date().toISOString()} ${code}\n`);
  } catch {
    // Routing must not depend on diagnostics.
  }
}

function hashFile(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function verifyTor() {
  const manifest = JSON.parse(fs.readFileSync(path.join(runtimeDir, "tor-manifest.json"), "utf8"));
  if (
    manifest?.schema !== 1 ||
    manifest.files === null ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files) ||
    typeof manifest.files["tor/tor.exe"] !== "string"
  ) {
    throw new Error("runtime_integrity_failed");
  }
  const listedFiles = Object.keys(manifest.files).sort();
  const actualFiles = listContainedFiles(path.join(runtimeDir, "tor")).sort();
  if (listedFiles.length !== actualFiles.length || listedFiles.some((name, index) => name !== actualFiles[index])) {
    throw new Error("runtime_integrity_failed");
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = resolveContainedFile(path.join(runtimeDir, "tor"), name);
    if (
      typeof expected !== "string" ||
      !/^[a-f0-9]{64}$/i.test(expected) ||
      !fs.existsSync(file) ||
      !fs.statSync(file).isFile() ||
      hashFile(file) !== expected.toLowerCase()
    ) {
      throw new Error("runtime_integrity_failed");
    }
  }
}

function torrcPath(file) {
  return JSON.stringify(file.replaceAll("\\", "/"));
}

function writeTorrc() {
  fs.mkdirSync(stateDir, { recursive: true });
  const torrc = path.join(stateDir, "torrc");
  const lines = [
    `SocksPort 127.0.0.1:${TOR_PORT}`,
    `DataDirectory ${torrcPath(path.join(stateDir, "data"))}`,
    `GeoIPFile ${torrcPath(path.join(runtimeDir, "tor", "data", "geoip"))}`,
    `GeoIPv6File ${torrcPath(path.join(runtimeDir, "tor", "data", "geoip6"))}`,
    `PidFile ${torrcPath(path.join(stateDir, "tor.pid"))}`,
    "ClientOnly 1",
    "ExcludeExitNodes {br}",
    "GeoIPExcludeUnknown 1",
    "SocksPolicy accept 127.0.0.1",
    "SocksPolicy reject *",
    "SafeLogging 1",
    "Log warn stdout",
  ];
  fs.writeFileSync(torrc, `${lines.join("\n")}\n`);
  return torrc;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

let ownershipQueue = Promise.resolve();
let lastOwnershipStartedAt = 0n;
let lastOwnershipResult = false;
function torRouteIsOwned(notBefore = process.hrtime.bigint()) {
  const request = ownershipQueue.then(async () => {
    if (lastOwnershipStartedAt >= notBefore) return lastOwnershipResult;
    lastOwnershipStartedAt = process.hrtime.bigint();
    lastOwnershipResult = await processOwnsLoopbackTcpListener(trustedTorPid, torExe, TOR_PORT);
    return lastOwnershipResult;
  });
  ownershipQueue = request.then(
    () => undefined,
    () => undefined,
  );
  return request;
}

async function waitForTor() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (
      (await torRouteIsOwned()) &&
      (await probeSocks5Tls(TOR_PORT, "gateway.discord.gg", 10_000)) &&
      (await torRouteIsOwned())
    ) {
      log("tor_ready");
      return;
    }
    await delay(500);
  }
  throw new Error("tor_unavailable");
}

let torProcess = null;
let torReady;
let trustedTorPid = 0;
try {
  verifyTor();
  const existingPid = fs.existsSync(pidPath) ? Number(fs.readFileSync(pidPath, "utf8").trim()) : 0;
  if (processMatchesExecutable(existingPid, torExe)) {
    trustedTorPid = existingPid;
    log("tor_existing");
  } else {
    fs.rmSync(pidPath, { force: true });
    torProcess = spawn(torExe, ["-f", writeTorrc()], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    torProcess.once("error", () => log("tor_spawn_failed"));
    trustedTorPid = Number(torProcess.pid) || 0;
    torProcess.once("exit", (code) => {
      trustedTorPid = 0;
      log(code === 0 ? "tor_stopped" : "tor_failed");
    });
    torProcess.unref();
    log("tor_started");
  }
  torReady = waitForTor();
} catch {
  log("tor_blocked");
  torReady = Promise.reject(new Error("tor_blocked"));
}
void torReady.catch(() => undefined);

const gatewayRelay = startGatewayRelay({
  listenPort: relayPort,
  torPort: TOR_PORT,
  torReady,
  authorizeTor: torRouteIsOwned,
  onRouted: () => log("gateway_routed"),
});

async function blockAllTraffic() {
  await session.defaultSession.setProxy({
    mode: "fixed_servers",
    proxyRules: `socks5://127.0.0.1:${relayPort}`,
  });
  await session.defaultSession.closeAllConnections();
}

app.whenReady().then(async () => {
  try {
    await Promise.all([gatewayRelay.ready, torReady]);
    const [canonical, regional, ordinary] = await Promise.all([
      session.defaultSession.resolveProxy("https://gateway.discord.gg"),
      session.defaultSession.resolveProxy("https://gateway-us-east1-b.discord.gg"),
      session.defaultSession.resolveProxy("https://discord.com"),
    ]);
    if (!canonical.includes(String(relayPort)) || !regional.includes(String(relayPort)) || ordinary !== "DIRECT") {
      await blockAllTraffic();
      log("route_verification_failed");
      return;
    }
    log("route_ready");
  } catch {
    try {
      await blockAllTraffic();
    } finally {
      log("route_blocked");
    }
  }
});

function loadDiscord() {
  const injectorPath = require.main.filename;
  const resourcesDir = path.join(path.dirname(injectorPath), "..");
  const originalAsar = path.join(resourcesDir, "app.golive-original.asar");
  const legacyOriginalAsar = path.join(resourcesDir, "app.asar.golive-original");
  if (!fs.existsSync(originalAsar) && fs.existsSync(legacyOriginalAsar)) {
    fs.renameSync(legacyOriginalAsar, originalAsar);
  }
  const discordPackage = require(path.join(originalAsar, "package.json"));
  require.main.filename = path.join(originalAsar, discordPackage.main);
  app.setAppPath(originalAsar);
  require(require.main.filename);
}

void gatewayRelay.ready
  .then(() => {
    if (app.isReady()) throw new Error("relay_started_too_late");
    loadDiscord();
  })
  .catch(() => {
    log("relay_blocked");
    app.exit(1);
  });
