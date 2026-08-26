import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectTarget,
  installTarget,
} from "../electron/installation.js";
import {
  cleanupTemporaryDirectories,
  fakeDiscord,
  fakePayload,
  installedFixture,
  temporaryDirectory,
} from "./installation-fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTemporaryDirectories();
});

describe("loader authentication", () => {
  it("detects and rebuilds a modified owned index.js", () => {
    const root = temporaryDirectory();
    const { dataRoot, payload, target } = installedFixture(root);
    const live = path.join(target.resourcesPath, "app.asar");
    fs.writeFileSync(path.join(live, "index.js"), "require('foreign-code');\n");

    expect(inspectTarget(target)).toMatchObject({ state: "installed", detail: expect.stringMatching(/modificado/) });
    installTarget(target, dataRoot, payload);
    expect(fs.readFileSync(path.join(live, "index.js"), "utf8")).toBe(`require(${JSON.stringify(payload)});\n`);
  });

  it("detects and removes an extra loader file during Repair", () => {
    const root = temporaryDirectory();
    const { dataRoot, payload, target } = installedFixture(root);
    const live = path.join(target.resourcesPath, "app.asar");
    fs.writeFileSync(path.join(live, "unexpected.js"), "foreign\n");

    expect(inspectTarget(target).detail).toMatch(/modificado/);
    installTarget(target, dataRoot, payload);
    expect(fs.readdirSync(live).sort()).toEqual([".golivebypass-owner.json", "index.js", "package.json"]);
  });

  it("detects and repairs a modified owner hash", () => {
    const root = temporaryDirectory();
    const { dataRoot, payload, target, transaction } = installedFixture(root);
    const marker = path.join(target.resourcesPath, "app.asar", ".golivebypass-owner.json");
    const owner = JSON.parse(fs.readFileSync(marker, "utf8")) as Record<string, unknown>;
    owner.originalSha256 = "0".repeat(64);
    fs.writeFileSync(marker, `${JSON.stringify(owner, null, 2)}\n`);

    expect(inspectTarget(target).detail).toMatch(/modificado/);
    installTarget(target, dataRoot, payload);
    expect(JSON.parse(fs.readFileSync(marker, "utf8")).originalSha256).toBe(transaction.originalSha256);
  });

  it("quarantines before authenticating and preserves a concurrently replaced loader", () => {
    const root = temporaryDirectory();
    const { dataRoot, payload, target, transaction } = installedFixture(root);
    const live = transaction.livePath;
    fs.writeFileSync(path.join(live, "index.js"), "modified owned loader\n");
    const rename = fs.renameSync.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (!replaced && source === live && destination === path.join(target.resourcesPath, ".golive-repair-loader")) {
        replaced = true;
        fs.rmSync(live, { recursive: true });
        fs.mkdirSync(live);
        fs.writeFileSync(path.join(live, "index.js"), "foreign replacement\n");
      }
      rename(source, destination);
    });

    expect(() => installTarget(target, dataRoot, payload)).toThrow(/preservado|falha preservada/);
    expect(fs.readFileSync(path.join(live, "index.js"), "utf8")).toBe("foreign replacement\n");
  });

  it("quarantines during rollback before deleting a replacement loader", () => {
    const root = temporaryDirectory();
    const dataRoot = path.join(root, "data");
    const { target } = fakeDiscord(root);
    const payload = fakePayload(dataRoot);
    const live = path.join(target.resourcesPath, "app.asar");
    const rename = fs.renameSync.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      rename(source, destination);
      if (!replaced && destination === live && path.basename(String(source)).startsWith(".golive-staging-")) {
        replaced = true;
        fs.rmSync(live, { recursive: true });
        fs.mkdirSync(live);
        fs.writeFileSync(path.join(live, "index.js"), "foreign during rollback\n");
      }
    });

    expect(() => installTarget(target, dataRoot, payload)).toThrow(/falha preservada/);
    expect(fs.readFileSync(path.join(live, "index.js"), "utf8")).toBe("foreign during rollback\n");
  });

  it("promotes a durable pending external backup during repair", () => {
    const root = temporaryDirectory();
    const { dataRoot, payload, target, transaction } = installedFixture(root);
    const pending = `${transaction.backupPath}.pending`;
    fs.renameSync(transaction.backupPath, pending);

    installTarget(target, dataRoot, payload);
    expect(fs.existsSync(pending)).toBe(false);
    expect(fs.existsSync(transaction.backupPath)).toBe(true);
  });
});
