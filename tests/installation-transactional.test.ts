import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverAllDiscordTargets,
  discoverDiscordTargets,
  inspectTarget,
  installTarget,
  installedRecords,
  uninstallAll,
} from "../electron/installation.js";
import {
  cleanupTemporaryDirectories,
  fakeDiscord,
  fakePayload,
  installedFixture,
  persistLegacyOriginalPath,
  recordPath,
  temporaryDirectory,
} from "./installation-fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTemporaryDirectories();
});

describe("transactional installation", () => {
  it("installs with two verified originals and restores the exact bytes", () => {
    const root = temporaryDirectory();
    const { dataRoot, original, target, transaction } = installedFixture(root);

    expect(inspectTarget(target).state).toBe("installed");
    expect(fs.readFileSync(transaction.backupPath)).toEqual(original);
    expect(fs.readFileSync(path.join(target.resourcesPath, "app.golive-original.asar"))).toEqual(original);
    expect(fs.statSync(path.join(target.resourcesPath, "app.asar")).isDirectory()).toBe(true);

    expect(uninstallAll(dataRoot, [target])).toEqual(["Discord"]);
    expect(fs.readFileSync(path.join(target.resourcesPath, "app.asar"))).toEqual(original);
    expect(inspectTarget(target).state).toBe("vanilla");
    expect(installedRecords(dataRoot)).toEqual([]);
    expect(fs.existsSync(transaction.backupPath)).toBe(false);
  });

  it("does not attribute a later foreign loader to a completed restoration", () => {
    const root = temporaryDirectory();
    const { dataRoot, target } = installedFixture(root);
    expect(uninstallAll(dataRoot, [target])).toEqual(["Discord"]);

    const live = path.join(target.resourcesPath, "app.asar");
    fs.renameSync(live, path.join(target.resourcesPath, "_app.asar"));
    fs.mkdirSync(live);
    fs.writeFileSync(path.join(live, "index.js"), "require('foreign-mod');\n");

    expect(inspectTarget(target).state).toBe("foreign");
    expect(uninstallAll(dataRoot, [target])).toEqual([]);
    expect(fs.readFileSync(path.join(live, "index.js"), "utf8")).toBe("require('foreign-mod');\n");
  });

  it("rejects a junction used as dataRoot before creating a journal", () => {
    if (process.platform !== "win32") return;
    const root = temporaryDirectory();
    const dataRoot = path.join(root, "data");
    const physicalData = path.join(root, "physical-data");
    const { target } = fakeDiscord(root);
    fakePayload(physicalData);
    fs.symlinkSync(physicalData, dataRoot, "junction");

    expect(() => installTarget(target, dataRoot, path.join(dataRoot, "runtime", "payload.cjs"))).toThrow(/Link|nova analise/);
    expect(fs.existsSync(path.join(physicalData, "transactions"))).toBe(false);
  });

  it("migrates a v0.1.0 local backup to an Electron-readable ASAR name", () => {
    const root = temporaryDirectory();
    const { dataRoot, original, payload, target } = installedFixture(root);
    const corrected = path.join(target.resourcesPath, "app.golive-original.asar");
    const legacy = path.join(target.resourcesPath, "app.asar.golive-original");
    fs.renameSync(corrected, legacy);
    const file = persistLegacyOriginalPath(dataRoot, legacy);

    expect(inspectTarget(target).state).toBe("installed");
    installTarget(target, dataRoot, payload);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(corrected)).toEqual(original);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).originalPath).toBe(corrected);
  });

  it("restores a v0.1.0 local backup directly", () => {
    const root = temporaryDirectory();
    const { dataRoot, original, target } = installedFixture(root);
    const legacy = path.join(target.resourcesPath, "app.asar.golive-original");
    fs.renameSync(path.join(target.resourcesPath, "app.golive-original.asar"), legacy);
    persistLegacyOriginalPath(dataRoot, legacy);

    expect(uninstallAll(dataRoot, [target])).toEqual(["Discord"]);
    expect(fs.readFileSync(path.join(target.resourcesPath, "app.asar"))).toEqual(original);
  });

  it("refuses a loader owned by another mod without changing it", () => {
    const root = temporaryDirectory();
    const dataRoot = path.join(root, "data");
    const { target } = fakeDiscord(root);
    const live = path.join(target.resourcesPath, "app.asar");
    fs.renameSync(live, path.join(target.resourcesPath, "_app.asar"));
    fs.mkdirSync(live);
    fs.writeFileSync(path.join(live, "index.js"), "require('vencord');\n");

    expect(inspectTarget(target).state).toBe("foreign");
    expect(() => installTarget(target, dataRoot, fakePayload(dataRoot))).toThrow(/preservar o outro modificador/);
    expect(fs.readFileSync(path.join(live, "index.js"), "utf8")).toBe("require('vencord');\n");
  });

  it("refuses to finish restoration when its installation record is missing", () => {
    const root = temporaryDirectory();
    const { dataRoot, target, transaction } = installedFixture(root);
    fs.rmSync(recordPath(dataRoot, transaction.id));

    expect(() => uninstallAll(dataRoot, [target])).toThrow(/continua modificado/);
    expect(inspectTarget(target).state).toBe("installed");
  });

  it("refuses to report restoration when a record and owned marker are both damaged", () => {
    const root = temporaryDirectory();
    const { dataRoot, target, transaction } = installedFixture(root);
    fs.rmSync(recordPath(dataRoot, transaction.id));
    fs.writeFileSync(path.join(transaction.livePath, ".golivebypass-owner.json"), "damaged");
    fs.rmSync(transaction.originalPath);

    expect(inspectTarget(target).state).toBe("broken");
    expect(() => uninstallAll(dataRoot, [target])).toThrow(/continua modificado/);
    expect(fs.statSync(transaction.livePath).isDirectory()).toBe(true);
  });

  it("refuses restoration success when only the external backup identifies an orphaned loader", () => {
    const root = temporaryDirectory();
    const { dataRoot, target, transaction } = installedFixture(root);
    fs.rmSync(recordPath(dataRoot, transaction.id));
    fs.rmSync(path.join(transaction.livePath, ".golivebypass-owner.json"));
    fs.rmSync(transaction.originalPath);

    expect(inspectTarget(target).state).toBe("foreign");
    expect(() => uninstallAll(dataRoot, [target])).toThrow(/continua modificado/);
    expect(fs.statSync(transaction.livePath).isDirectory()).toBe(true);
  });

  it("detects a recordless owned loader in an older Discord version", () => {
    const root = temporaryDirectory();
    const dataRoot = path.join(root, "data");
    const older = fakeDiscord(root, "1.0.99").target;
    const transaction = installTarget(older, dataRoot, fakePayload(dataRoot));
    fakeDiscord(root, "1.0.100");
    fs.rmSync(recordPath(dataRoot, transaction.id));

    const allTargets = discoverAllDiscordTargets(root);
    expect(discoverDiscordTargets(root)[0]?.version).toBe("1.0.100");
    expect(() => uninstallAll(dataRoot, allTargets)).toThrow(/continua modificado/);
    expect(inspectTarget(older).state).toBe("installed");
  });

});
