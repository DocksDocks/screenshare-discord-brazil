import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.resolve("runtime", "payload.cjs"), "utf8");

describe("Discord payload startup", () => {
  it("starts the local gateway relay before loading Discord", () => {
    expect(source.indexOf("startGatewayRelay({")).toBeGreaterThan(0);
    expect(source.indexOf("startGatewayRelay({")).toBeLessThan(source.indexOf("const discordPackage = require("));
    expect(source).toContain("void gatewayRelay.ready");
    expect(source).toContain("if (app.isReady()) throw new Error(\"relay_started_too_late\")");
  });

  it("waits for authenticated Tor readiness without resetting successful sessions", () => {
    expect(source).toContain('probeSocks5Tls(TOR_PORT, "gateway.discord.gg"');
    expect(source).toContain("processOwnsLoopbackTcpListener(trustedTorPid, torExe, TOR_PORT)");
    expect(source).toContain("if (lastOwnershipStartedAt >= notBefore) return lastOwnershipResult");
    expect(source).toContain("ownershipQueue = request.then(");
    expect(source).toContain("await Promise.all([gatewayRelay.ready, torReady])");
    expect(source).not.toContain('setProxy({ mode: "pac_script"');
    expect(source.match(/closeAllConnections/g)).toHaveLength(1);
  });
});
