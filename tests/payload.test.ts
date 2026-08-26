import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.resolve("runtime", "payload.cjs"), "utf8");
const nodeRequire = createRequire(import.meta.url);
const readyGateSource = source.slice(
  source.indexOf("function holdDiscordReady"),
  source.indexOf("\nfunction loadDiscord"),
);

interface TestApp extends EventEmitter {
  isReady(): boolean;
  whenReady(): Promise<void>;
}

function deferred(): { promise: Promise<void>; reject(error: Error): void; resolve(): void } {
  let reject!: (error: Error) => void;
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function installReadyGate(app: TestApp, ready: Promise<void>, nativeReady: () => boolean, load = () => undefined): void {
  vm.runInNewContext(`${readyGateSource}\nvoid holdDiscordReady(ready, load).catch(() => undefined);`, {
    app,
    electronIsReady: nativeReady,
    electronReadyArguments: ["native-ready"],
    originalIsReady: app.isReady,
    originalWhenReady: app.whenReady,
    load,
    process: { nextTick: process.nextTick.bind(process) },
    ready,
  });
}

function executeRoutingPrelude(conflictingSwitch?: string): {
  appended: Array<[string, string]>;
  error: string;
  exitCode: number | null;
  guardInstalled: boolean;
} {
  const appended: Array<[string, string]> = [];
  let exitCode: number | null = null;
  let guardInstalled = false;
  const app = {
    commandLine: {
      appendSwitch: (name: string, value: string) => appended.push([name, value]),
      hasSwitch: (name: string) => name === conflictingSwitch,
    },
    exit: (code: number) => {
      exitCode = code;
    },
  };
  const runtimeRequire = (id: string): unknown => {
    if (id === "node:crypto" || id === "node:path") return nodeRequire(id);
    if (id === "node:child_process") return { spawn: () => undefined };
    if (id === "node:fs") {
      return {
        appendFileSync: () => undefined,
        readFileSync: () => "__GATEWAY_RELAY_PORT__",
      };
    }
    if (id === "electron") return { app, session: {} };
    if (id === "./gateway-relay.cjs") return { relayPortForExecutable: () => 19060 };
    if (id === "./runtime-safety.cjs") {
      return {
        installNodeNetworkGuards: () => {
          guardInstalled = true;
          throw new Error("stop_after_route_configuration");
        },
      };
    }
    throw new Error(`unexpected require: ${id}`);
  };

  let error = "";
  try {
    vm.runInNewContext(source, {
      __dirname: "C:\\runtime",
      Buffer,
      process: { execPath: "C:\\Discord\\Discord.exe", platform: "win32" },
      require: runtimeRequire,
    });
  } catch (caught) {
    error = String(caught);
  }
  return { appended, error, exitCode, guardInstalled };
}

describe("Discord payload startup", () => {
  it("rejects conflicting Chromium routing before installing its fail-closed switches", () => {
    for (const name of [
      "host-resolver-rules",
      "host-rules",
      "no-proxy-server",
      "proxy-bypass-list",
      "proxy-pac-url",
      "proxy-server",
    ]) {
      expect(source).toContain(`"${name}"`);
    }
    expect(source.indexOf("CONFLICTING_CHROMIUM_SWITCHES.some")).toBeLessThan(
      source.indexOf('app.commandLine.appendSwitch("proxy-pac-url"'),
    );
    expect(source).toContain('app.commandLine.appendSwitch("host-resolver-rules", HOST_RESOLVER_RULES)');
    expect(source).toContain(
      '"MAP discord.gg ^NOTFOUND, MAP *.discord.gg ^NOTFOUND, MAP discord.gg. ^NOTFOUND, MAP *.discord.gg. ^NOTFOUND"',
    );
    expect(source).toContain('app.commandLine.getSwitchValue(name) === pacUrl');
    expect(source).toContain('app.commandLine.getSwitchValue(name) === HOST_RESOLVER_RULES');
  });

  it("exits before appending or loading anything when a Chromium route switch already exists", () => {
    const result = executeRoutingPrelude("proxy-server");
    expect(result.error).toContain("chromium_route_conflict");
    expect(result.exitCode).toBe(1);
    expect(result.appended).toEqual([]);
    expect(result.guardInstalled).toBe(false);
  });

  it("installs the PAC and DNS failure rules before continuing startup", () => {
    const result = executeRoutingPrelude();
    expect(result.error).toContain("stop_after_route_configuration");
    expect(result.exitCode).toBeNull();
    expect(result.guardInstalled).toBe(true);
    expect(result.appended).toHaveLength(2);
    expect(result.appended[0][0]).toBe("proxy-pac-url");
    expect(result.appended[0][1]).toMatch(/^data:application\/x-ns-proxy-autoconfig;base64,/);
    expect(result.appended[1]).toEqual([
      "host-resolver-rules",
      "MAP discord.gg ^NOTFOUND, MAP *.discord.gg ^NOTFOUND, MAP discord.gg. ^NOTFOUND, MAP *.discord.gg. ^NOTFOUND",
    ]);
  });

  it("does not load Discord until the relay, Tor, and exact Chromium route are authenticated", () => {
    expect(source.indexOf("startGatewayRelay({")).toBeGreaterThan(0);
    expect(source.indexOf("startGatewayRelay({")).toBeLessThan(source.indexOf("const discordPackage = require("));
    expect(source).toContain("await Promise.all([electronReady, gatewayRelay.ready])");
    expect(source).toContain("holdDiscordReady(startupReady, loadDiscord)");
    expect(source).not.toContain("loadDiscord();");
    expect(source).toContain("app.whenReady = () => ready");
    expect(source).toContain("app.isReady = () => false");
  });

  it("loads and replays even prototype-registered readiness only after startup succeeds", async () => {
    const startup = deferred();
    let nativeReady = false;
    const app = Object.assign(new EventEmitter(), {
      isReady: () => nativeReady,
      whenReady: () => Promise.resolve(),
    }) as TestApp;
    const calls: string[] = [];
    installReadyGate(app, startup.promise, () => nativeReady, () => {
      calls.push("load");
      EventEmitter.prototype.on.call(app, "ready", (argument) => calls.push(`prototype:${argument}`));
    });

    nativeReady = true;
    app.emit("ready", "unguarded-native-ready");
    await Promise.resolve();
    expect(calls).toEqual([]);

    startup.resolve();
    await startup.promise;
    await Promise.resolve();
    expect(calls).toEqual(["load", "prototype:native-ready"]);
  });

  it("releases deferred readiness listeners only after startup succeeds", async () => {
    const startup = deferred();
    let nativeReady = false;
    const nativeWhenReady = () => Promise.resolve();
    const nativeIsReady = () => nativeReady;
    const app = Object.assign(new EventEmitter(), {
      isReady: nativeIsReady,
      whenReady: nativeWhenReady,
    }) as TestApp;
    const calls: string[] = [];
    const removed = () => calls.push("removed");

    installReadyGate(app, startup.promise, () => nativeReady, () => {
      app.on("ready", () => calls.push("remove-all"));
      app.removeAllListeners("ready");
      app.on("ready", (argument) => calls.push(`on:${argument}`));
      app.prependOnceListener("ready", (argument) => calls.push(`prepend:${argument}`));
      app.once("ready", removed);
      app.off("ready", removed);
      void app.whenReady().then(() => calls.push("promise"));
    });

    nativeReady = true;
    app.emit("ready", "unguarded-native-ready");
    await Promise.resolve();
    expect(app.isReady()).toBe(false);
    expect(calls).toEqual([]);

    startup.resolve();
    await startup.promise;
    await Promise.resolve();
    expect(calls).toEqual(["prepend:native-ready", "on:native-ready", "promise"]);
    expect(app.isReady()).toBe(true);
    expect(app.whenReady).toBe(nativeWhenReady);
    expect(app.isReady).toBe(nativeIsReady);
  });

  it("keeps Discord readiness blocked when startup fails", async () => {
    const startup = deferred();
    const app = Object.assign(new EventEmitter(), {
      isReady: () => true,
      whenReady: () => Promise.resolve(),
    }) as TestApp;
    let readyListenerCalled = false;

    let loaded = false;
    installReadyGate(app, startup.promise, () => true, () => {
      loaded = true;
      app.once("ready", () => {
        readyListenerCalled = true;
      });
    });
    const discordReady = app.whenReady().catch(() => undefined);
    startup.reject(new Error("route_blocked"));
    await discordReady;
    await Promise.resolve();

    expect(app.isReady()).toBe(false);
    expect(loaded).toBe(false);
    expect(readyListenerCalled).toBe(false);
  });

  it("waits for authenticated Tor readiness asynchronously without resetting successful sessions", () => {
    expect(source).toContain('probeSocks5Tls(TOR_PORT, "gateway.discord.gg"');
    expect(source).toContain("processOwnsLoopbackTcpListener(trustedTorPid, torExe, TOR_PORT)");
    expect(source).toContain("if (lastOwnershipStartedAt >= notBefore) return lastOwnershipResult");
    expect(source).toContain("ownershipQueue = request.then(");
    expect(source).toContain("if (await processMatchesExecutable(existingPid, torExe))");
    expect(source).toContain("await torReady");
    expect(source).not.toContain('setProxy({ mode: "pac_script"');
    expect(source.match(/closeAllConnections/g)).toHaveLength(1);
  });

  it("requires exact effective routes and exits after installing a blocking route on failure", () => {
    expect(source).toContain("canonical !== expectedGatewayRoute");
    expect(source).toContain("regional !== expectedGatewayRoute");
    expect(source).toContain('ordinary !== "DIRECT"');
    expect(source).not.toContain("canonical.includes(");
    expect(source).not.toContain("regional.includes(");
    expect(source).toContain("await blockAllTraffic()");
    expect(source).toContain("app.exit(1)");
  });

  it("blocks Node networking before Discord is required without replacing Electron net", () => {
    expect(source.indexOf("installNodeNetworkGuards();")).toBeLessThan(source.indexOf("const discordPackage = require("));
    expect(source).not.toContain("electron.net");
  });
});
