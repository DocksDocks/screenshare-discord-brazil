import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRuntime, runtimeSourceReady } from "../electron/runtime.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "golive-runtime-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function projectLayout(root: string): void {
  fs.mkdirSync(path.join(root, "runtime"), { recursive: true });
  fs.mkdirSync(path.join(root, "vendor", "tor", "tor"), { recursive: true });
  fs.writeFileSync(path.join(root, "runtime", "payload.cjs"), "payload\n");
  fs.writeFileSync(path.join(root, "runtime", "proxy.pac"), "pac\n");
  fs.writeFileSync(path.join(root, "runtime", "runtime-safety.cjs"), "safety\n");
  fs.writeFileSync(path.join(root, "vendor", "tor", "tor", "tor.exe"), "tor\n");
  fs.writeFileSync(
    path.join(root, "vendor", "tor-manifest.json"),
    JSON.stringify({
      schema: 1,
      version: "test",
      source: "https://example.invalid/tor",
      archiveSha256: "test",
      files: { "tor/tor.exe": sha256("tor\n") },
    }),
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("runtime source layouts", () => {
  it("recognizes the split development layout and stages a unified runtime", () => {
    const root = temporaryDirectory();
    const dataRoot = path.join(root, "data");
    projectLayout(root);

    expect(runtimeSourceReady(root)).toBe(true);
    expect(prepareRuntime(root, dataRoot)).toBe(path.join(dataRoot, "runtime", "payload.cjs"));
    expect(fs.readFileSync(path.join(dataRoot, "runtime", "tor", "tor", "tor.exe"), "utf8")).toBe("tor\n");
    expect(runtimeSourceReady(path.join(dataRoot, "runtime"))).toBe(true);
  });

  it("rejects a Tor file that no longer matches the pinned manifest", () => {
    const root = temporaryDirectory();
    projectLayout(root);
    fs.writeFileSync(path.join(root, "vendor", "tor", "tor", "tor.exe"), "changed\n");
    expect(runtimeSourceReady(root)).toBe(false);
  });

  it("rejects Tor files that are absent from the manifest", () => {
    const root = temporaryDirectory();
    projectLayout(root);
    fs.writeFileSync(path.join(root, "vendor", "tor", "unexpected.dll"), "unexpected\n");
    expect(runtimeSourceReady(root)).toBe(false);
  });

  it("rejects a junction used as the Tor root", () => {
    const root = temporaryDirectory();
    projectLayout(root);
    const torRoot = path.join(root, "vendor", "tor");
    const physicalRoot = path.join(root, "physical-tor");
    fs.renameSync(torRoot, physicalRoot);
    fs.symlinkSync(physicalRoot, torRoot, "junction");
    expect(runtimeSourceReady(root)).toBe(false);
  });

  it("rejects manifest entries that escape the Tor runtime", () => {
    const root = temporaryDirectory();
    projectLayout(root);
    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "outside\n");
    fs.writeFileSync(
      path.join(root, "vendor", "tor-manifest.json"),
      JSON.stringify({
        schema: 1,
        version: "test",
        source: "https://example.invalid/tor",
        archiveSha256: "test",
        files: {
          "tor/tor.exe": sha256("tor\n"),
          "../outside.txt": sha256("outside\n"),
        },
      }),
    );

    expect(runtimeSourceReady(root)).toBe(false);
  });
});
