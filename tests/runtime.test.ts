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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceSha256(file: string): string {
  return sha256(fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n"));
}

function projectLayout(root: string): void {
  fs.mkdirSync(path.join(root, "runtime"), { recursive: true });
  fs.mkdirSync(path.join(root, "vendor", "tor", "tor"), { recursive: true });
  fs.writeFileSync(path.join(root, "runtime", "payload.cjs"), "payload\n");
  fs.writeFileSync(path.join(root, "runtime", "proxy.pac"), "pac\n");
  fs.writeFileSync(path.join(root, "runtime", "gateway-relay.cjs"), "relay\n");
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

function unifiedLayout(root: string): void {
  fs.mkdirSync(path.join(root, "tor", "tor"), { recursive: true });
  fs.writeFileSync(path.join(root, "payload.cjs"), "changed payload\n");
  fs.writeFileSync(path.join(root, "proxy.pac"), "changed pac\n");
  fs.writeFileSync(path.join(root, "gateway-relay.cjs"), "changed relay\n");
  fs.writeFileSync(path.join(root, "runtime-safety.cjs"), "changed safety\n");
  fs.writeFileSync(path.join(root, "tor", "tor", "tor.exe"), "changed tor\n");
  fs.writeFileSync(
    path.join(root, "tor-manifest.json"),
    JSON.stringify({
      schema: 1,
      version: "changed",
      source: "https://example.invalid/changed-tor",
      archiveSha256: "changed",
      files: { "tor/tor.exe": sha256("changed tor\n") },
    }),
  );
}

function withResourcesPath<T>(resourcesPath: string, operation: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: resourcesPath });
  try {
    return operation();
  } finally {
    if (previous) Object.defineProperty(process, "resourcesPath", previous);
    else Reflect.deleteProperty(process, "resourcesPath");
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("runtime source layouts", () => {
  it("pins every external packaged source file and the Tor manifest in the compiled module", () => {
    const runtimeSource = fs.readFileSync(path.resolve("electron", "runtime.ts"), "utf8");
    for (const file of [
      path.resolve("runtime", "gateway-relay.cjs"),
      path.resolve("runtime", "payload.cjs"),
      path.resolve("runtime", "proxy.pac"),
      path.resolve("runtime", "runtime-safety.cjs"),
      path.resolve("vendor", "tor-manifest.json"),
    ]) {
      expect(runtimeSource).toContain(`"${path.basename(file)}": "${sourceSha256(file)}"`);
    }
    expect(runtimeSource).not.toContain('"runtime.ts":');
  });

  it("recognizes the split development layout and stages a unified runtime", () => {
    const root = temporaryDirectory();
    const dataRoot = path.join(root, "data");
    projectLayout(root);

    expect(runtimeSourceReady(root)).toBe(true);
    expect(prepareRuntime(root, dataRoot)).toBe(path.join(dataRoot, "runtime", "payload.cjs"));
    expect(fs.readFileSync(path.join(dataRoot, "runtime", "tor", "tor", "tor.exe"), "utf8")).toBe("tor\n");
    expect(runtimeSourceReady(path.join(dataRoot, "runtime"))).toBe(true);
  });

  it("replaces a complete stale runtime without changing its stable payload path", () => {
    const root = temporaryDirectory();
    const staleSource = path.join(root, "stale");
    const currentSource = path.join(root, "current");
    const dataRoot = path.join(root, "data");
    unifiedLayout(staleSource);
    projectLayout(currentSource);

    const payloadPath = prepareRuntime(staleSource, dataRoot);
    expect(fs.readFileSync(payloadPath, "utf8")).toBe("changed payload\n");
    expect(prepareRuntime(currentSource, dataRoot)).toBe(payloadPath);
    expect(fs.readFileSync(payloadPath, "utf8")).toBe("payload\n");
    expect(fs.existsSync(path.join(dataRoot, ".runtime-previous"))).toBe(false);
  });

  it("recovers a runtime promotion interrupted after preserving the previous tree", () => {
    const root = temporaryDirectory();
    const sourceRoot = path.join(root, "source");
    const dataRoot = path.join(root, "data");
    projectLayout(sourceRoot);
    prepareRuntime(sourceRoot, dataRoot);
    fs.renameSync(path.join(dataRoot, "runtime"), path.join(dataRoot, ".runtime-previous"));

    expect(prepareRuntime(sourceRoot, dataRoot)).toBe(path.join(dataRoot, "runtime", "payload.cjs"));
    expect(fs.readFileSync(path.join(dataRoot, "runtime", "payload.cjs"), "utf8")).toBe("payload\n");
    expect(fs.existsSync(path.join(dataRoot, ".runtime-previous"))).toBe(false);
  });

  it("rejects self-consistent changes to packaged source code and its adjacent Tor manifest", () => {
    const root = temporaryDirectory();
    const resources = path.join(root, "resources");
    const sourceRoot = path.join(resources, "runtime");
    unifiedLayout(sourceRoot);

    withResourcesPath(resources, () => {
      expect(runtimeSourceReady(sourceRoot)).toBe(false);
      expect(() => prepareRuntime(sourceRoot, path.join(root, "data"))).toThrow("Runtime empacotado invalido");
    });
  });

  it("does not treat a nested packaged replacement as a split development source", () => {
    const root = temporaryDirectory();
    const resources = path.join(root, "resources");
    const sourceRoot = path.join(resources, "runtime");
    projectLayout(sourceRoot);

    withResourcesPath(resources, () => expect(runtimeSourceReady(sourceRoot)).toBe(false));
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
