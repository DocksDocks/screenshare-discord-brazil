"use strict";

const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { app, session } = require("electron");
const { probeSocks5Tls, relayPortForExecutable, startGatewayRelay } = require("./gateway-relay.cjs");
const {
  installNodeNetworkGuards,
  listContainedFiles,
  processMatchesExecutable,
  processOwnsLoopbackTcpListener,
  resolveContainedFile,
} = require("./runtime-safety.cjs");

const TOR_PORT = 9060;
const CONFLICTING_CHROMIUM_SWITCHES = [
  "host-resolver-rules",
  "host-rules",
  "no-proxy-server",
  "proxy-auto-detect",
  "proxy-bypass-list",
  "proxy-pac-url",
  "proxy-server",
];
const HOST_RESOLVER_RULES =
  "MAP discord.gg ^NOTFOUND, MAP *.discord.gg ^NOTFOUND, MAP discord.gg. ^NOTFOUND, MAP *.discord.gg. ^NOTFOUND";
const runtimeDir = __dirname;
const dataRoot = path.dirname(runtimeDir);
const stateDir = path.join(dataRoot, "tor-state");
const pidPath = path.join(stateDir, "tor.pid");
const torExe = path.join(runtimeDir, "tor", "tor", "tor.exe");
const relayPort = relayPortForExecutable(process.execPath);
const pacTemplate = fs.readFileSync(path.join(runtimeDir, "proxy.pac"), "utf8");
if (pacTemplate.split("__GATEWAY_RELAY_PORT__").length !== 2) throw new Error("runtime_integrity_failed");
const pacText = pacTemplate.replaceAll("__GATEWAY_RELAY_PORT__", String(relayPort));
const pacUrl = `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pacText).toString("base64")}`;

function log(code) {
  try {
    fs.appendFileSync(path.join(dataRoot, "runtime.log"), `${new Date().toISOString()} ${code}\n`);
  } catch {
    // Routing must not depend on diagnostics.
  }
}

if (process.platform !== "win32") {
  log("unsupported_platform");
  app.exit(1);
  throw new Error("unsupported_platform");
}
if (CONFLICTING_CHROMIUM_SWITCHES.some((name) => app.commandLine.hasSwitch(name))) {
  log("chromium_route_conflict");
  app.exit(1);
  throw new Error("chromium_route_conflict");
}

// These switches must be installed synchronously before Chromium creates its default session.
app.commandLine.appendSwitch("proxy-pac-url", pacUrl);
app.commandLine.appendSwitch("host-resolver-rules", HOST_RESOLVER_RULES);
installNodeNetworkGuards();

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

let trustedTorPid = 0;
async function startTor() {
  verifyTor();
  const existingPid = fs.existsSync(pidPath) ? Number(fs.readFileSync(pidPath, "utf8").trim()) : 0;
  if (await processMatchesExecutable(existingPid, torExe)) {
    trustedTorPid = existingPid;
    log("tor_existing");
  } else {
    fs.rmSync(pidPath, { force: true });
    const torProcess = spawn(torExe, ["-f", writeTorrc()], {
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
  await waitForTor();
}

const torReady = startTor().catch(() => {
  log("tor_blocked");
  throw new Error("tor_blocked");
});
void torReady.catch(() => undefined);

const gatewayRelay = startGatewayRelay({
  listenPort: relayPort,
  torPort: TOR_PORT,
  torReady,
  authorizeTor: torRouteIsOwned,
  onRouted: () => log("gateway_routed"),
});

const originalWhenReady = app.whenReady;
const originalIsReady = app.isReady;
const electronWhenReady = originalWhenReady.bind(app);
const electronIsReady = originalIsReady.bind(app);
let electronReadyArguments = [];
app.once("ready", (...args) => {
  electronReadyArguments = args;
});
const electronReady = electronWhenReady();

async function blockAllTraffic() {
  await session.defaultSession.setProxy({
    mode: "fixed_servers",
    proxyRules: `socks5://127.0.0.1:${relayPort}`,
  });
  await session.defaultSession.closeAllConnections();
}

function chromiumRouteIsConfigured() {
  return CONFLICTING_CHROMIUM_SWITCHES.every((name) => {
    if (name === "proxy-pac-url") return app.commandLine.getSwitchValue(name) === pacUrl;
    if (name === "host-resolver-rules") return app.commandLine.getSwitchValue(name) === HOST_RESOLVER_RULES;
    return !app.commandLine.hasSwitch(name);
  });
}

async function verifyStartupRoute() {
  await Promise.all([electronReady, gatewayRelay.ready]);
  const expectedGatewayRoute = `SOCKS5 127.0.0.1:${relayPort}`;
  const [canonical, regional, ordinary] = await Promise.all([
    session.defaultSession.resolveProxy("https://gateway.discord.gg"),
    session.defaultSession.resolveProxy("https://gateway-us-east1-b.discord.gg"),
    session.defaultSession.resolveProxy("https://discord.com"),
  ]);
  if (
    !chromiumRouteIsConfigured() ||
    canonical !== expectedGatewayRoute ||
    regional !== expectedGatewayRoute ||
    ordinary !== "DIRECT"
  ) {
    log("route_verification_failed");
    throw new Error("route_verification_failed");
  }
  await torReady;
  log("route_ready");
}

const startupReady = verifyStartupRoute().catch(async (error) => {
  try {
    await electronReady;
    await blockAllTraffic();
  } finally {
    log("route_blocked");
    app.exit(1);
  }
  throw error;
});
void startupReady.catch(() => undefined);

function holdDiscordReady(ready, load) {
  const initialReadyListeners = new Set(app.rawListeners("ready"));

  app.whenReady = () => ready;
  app.isReady = () => false;

  return ready.then(
    () => {
      load();
      const listeners = app.rawListeners("ready").filter((listener) => !initialReadyListeners.has(listener));
      for (const listener of listeners) {
        app.removeListener("ready", listener);
      }
      app.whenReady = originalWhenReady;
      app.isReady = originalIsReady;
      for (const listener of listeners) {
        try {
          Reflect.apply(listener, app, electronReadyArguments);
        } catch (error) {
          process.nextTick(() => {
            throw error;
          });
          break;
        }
      }
    },
  );
}

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

void holdDiscordReady(startupReady, loadDiscord)
  .catch(() => {
    log("discord_blocked");
    app.exit(1);
  });
