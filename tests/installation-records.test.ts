import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectTarget,
  installedRecords,
  installTarget,
  uninstallAll,
} from "../electron/installation.js";
import {
  cleanupTemporaryDirectories,
  fakeDiscord,
  fakePayload,
  installedFixture,
  recordPath,
  temporaryDirectory,
} from "./installation-fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTemporaryDirectories();
});

describe("transactional installation", () => {
  it("refuses a malformed installation record", () => {
    const root = temporaryDirectory();
    const { dataRoot, target, transaction } = installedFixture(root);
    fs.writeFileSync(recordPath(dataRoot, transaction.id), "not json");

    expect(() => uninstallAll(dataRoot, [target])).toThrow(/Registro de instalacao invalido/);
    expect(inspectTarget(target).state).toBe("installed");
  });

  it("rejects an out-of-root backup path in an installation record", () => {
    const root = temporaryDirectory();
    const { dataRoot, transaction } = installedFixture(root);
    const outside = path.join(root, "outside.asar");
    fs.writeFileSync(outside, "sentinel");
    const file = recordPath(dataRoot, transaction.id);
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    record.backupPath = outside;
    fs.writeFileSync(file, JSON.stringify(record));

    expect(() => installedRecords(dataRoot)).toThrow(/Registro de instalacao invalido/);
    expect(fs.readFileSync(outside, "utf8")).toBe("sentinel");
  });

  it("rejects an installation record whose filename does not match its id", () => {
    const root = temporaryDirectory();
    const { dataRoot, transaction } = installedFixture(root);
    const mismatchedId = transaction.id === "0".repeat(24) ? "1".repeat(24) : "0".repeat(24);
    fs.renameSync(recordPath(dataRoot, transaction.id), recordPath(dataRoot, mismatchedId));

    expect(() => installedRecords(dataRoot)).toThrow(/Registro de instalacao invalido/);
  });

  it("rejects non-finite-compatible persisted metadata", () => {
    const root = temporaryDirectory();
    const { dataRoot, transaction } = installedFixture(root);
    const file = recordPath(dataRoot, transaction.id);
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    record.originalMtimeMs = null;
    fs.writeFileSync(file, JSON.stringify(record));

    expect(() => installedRecords(dataRoot)).toThrow(/Registro de instalacao invalido/);
  });

  it("rejects an out-of-range timestamp before moving the loader", () => {
    const root = temporaryDirectory();
    const { dataRoot, target, transaction } = installedFixture(root);
    const file = recordPath(dataRoot, transaction.id);
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    record.originalMtimeMs = 8_640_000_000_000_001;
    fs.writeFileSync(file, JSON.stringify(record));

    expect(() => uninstallAll(dataRoot, [target])).toThrow(/Registro de instalacao invalido/);
    expect(fs.statSync(transaction.livePath).isDirectory()).toBe(true);
  });

  it("accepts persisted Windows paths whose drive-letter casing changed", () => {
    if (process.platform !== "win32") return;
    const root = temporaryDirectory();
    const { dataRoot, transaction } = installedFixture(root);
    const file = recordPath(dataRoot, transaction.id);
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    for (const key of [
      "resourcesPath",
      "executablePath",
      "backupPath",
      "livePath",
      "originalPath",
      "stagePath",
      "recordPath",
    ]) {
      const value = record[key];
      if (typeof value === "string") record[key] = `${value[0] === value[0]?.toLowerCase() ? value[0]?.toUpperCase() : value[0]?.toLowerCase()}${value.slice(1)}`;
    }
    fs.writeFileSync(file, JSON.stringify(record));

    expect(installedRecords(dataRoot)).toHaveLength(1);
  });

  it("does not confuse Unicode paths that JavaScript lowercase maps together", () => {
    if (process.platform !== "win32") return;
    const root = temporaryDirectory();
    const localAppData = path.join(root, "K");
    const dataRoot = path.join(root, "\u212a", "GoLiveBypassSafe");
    const { target } = fakeDiscord(localAppData);

    expect(() => installTarget(target, dataRoot, fakePayload(dataRoot))).toThrow(/fora de LOCALAPPDATA/);
  });

  it("rejects hard-linked records and independent-backup collapse", () => {
    const root = temporaryDirectory();
    const { dataRoot, payload, target, transaction } = installedFixture(root);
    const record = recordPath(dataRoot, transaction.id);
    const recordAlias = path.join(root, "record-alias.json");
    fs.linkSync(record, recordAlias);

    expect(() => installedRecords(dataRoot)).toThrow(/hard link/);
    expect(fs.readFileSync(recordAlias, "utf8")).toBe(fs.readFileSync(record, "utf8"));

    fs.rmSync(recordAlias);
    fs.rmSync(transaction.backupPath);
    fs.linkSync(transaction.originalPath, transaction.backupPath);
    expect(() => installTarget(target, dataRoot, payload)).toThrow(/falha preservada|mesmo arquivo|hard link/);
  });
});
