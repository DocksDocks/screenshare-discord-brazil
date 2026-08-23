import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface RuntimeSafety {
  listContainedFiles(root: string): string[];
  processMatchesExecutable(pid: number, expectedExecutable: string): boolean;
  resolveContainedFile(root: string, name: string): string;
}

const require = createRequire(import.meta.url);
const safety = require("../runtime/runtime-safety.cjs") as RuntimeSafety;

describe("runtime safety", () => {
  it("resolves only files below the declared root", () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "golive-runtime-safety-test-"));
    const root = path.join(sandbox, "root");
    const outside = path.join(sandbox, "outside");
    fs.mkdirSync(path.join(root, "tor"), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(root, "tor", "tor.exe"), "tor");
    fs.writeFileSync(path.join(outside, "outside.txt"), "outside");
    fs.symlinkSync(outside, path.join(root, "link"), "junction");
    const rootLink = path.join(sandbox, "root-link");
    fs.symlinkSync(root, rootLink, "junction");
    try {
      expect(safety.resolveContainedFile(root, "tor/tor.exe")).toBe(fs.realpathSync.native(path.join(root, "tor", "tor.exe")));
      expect(() => safety.resolveContainedFile(root, "../outside.txt")).toThrow();
      expect(() => safety.resolveContainedFile(root, "C:\\Windows\\System32\\kernel32.dll")).toThrow();
      expect(() => safety.resolveContainedFile(root, "link/outside.txt")).toThrow();
      expect(() => safety.listContainedFiles(root)).toThrow();
      expect(() => safety.resolveContainedFile(rootLink, "tor/tor.exe")).toThrow();
      expect(() => safety.listContainedFiles(rootLink)).toThrow();
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("matches a PID only to its actual executable", () => {
    expect(safety.processMatchesExecutable(process.pid, process.execPath)).toBe(true);
    expect(safety.processMatchesExecutable(process.pid, path.join(os.tmpdir(), "not-node.exe"))).toBe(false);
    expect(safety.processMatchesExecutable(-1, process.execPath)).toBe(false);
  });
});
