import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const pac = fs.readFileSync(path.resolve("runtime", "proxy.pac"), "utf8");

function resolve(host: string): string {
  return vm.runInNewContext(`${pac}\nFindProxyForURL(${JSON.stringify(`https://${host}`)}, ${JSON.stringify(host)});`) as string;
}

describe("fail-closed PAC", () => {
  it.each([
    "discord.gg",
    "gateway.discord.gg",
    "gateway-us-east1-b.discord.gg",
    "remote-auth-gateway.discord.gg",
  ])("routes %s through the dedicated Tor port with no fallback", (host) => {
    expect(resolve(host)).toBe("SOCKS5 127.0.0.1:9060");
    expect(resolve(host)).not.toContain(";");
  });

  it.each(["discord.com", "cdn.discordapp.com", "discord.gg.evil.example", "example.com"])(
    "leaves %s direct",
    (host) => expect(resolve(host)).toBe("DIRECT"),
  );
});
