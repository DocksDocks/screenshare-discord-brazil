import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectTarget,
  recoverTransactions,
  uninstallAll,
} from "../electron/installation.js";
import {
  cleanupTemporaryDirectories,
  installedFixture,
  journalPath,
  temporaryDirectory,
} from "./installation-fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTemporaryDirectories();
});

describe("uninstall recovery sources", () => {
  it("falls back to the valid external backup when the local original is corrupt", () => {
    const root = temporaryDirectory();
    const { dataRoot, original, target, transaction } = installedFixture(root);
    fs.writeFileSync(transaction.originalPath, "corrupt local original");

    expect(uninstallAll(dataRoot, [target])).toEqual(["Discord"]);
    expect(fs.readFileSync(transaction.livePath)).toEqual(original);
    expect(inspectTarget(target).state).toBe("vanilla");
  });

  it("restores an independent file when the local original gained a hard-link alias", () => {
    const root = temporaryDirectory();
    const { dataRoot, original, target, transaction } = installedFixture(root);
    const alias = path.join(root, "original-alias.asar");
    fs.linkSync(transaction.originalPath, alias);

    expect(uninstallAll(dataRoot, [target])).toEqual(["Discord"]);
    expect(fs.readFileSync(transaction.livePath)).toEqual(original);
    expect(fs.statSync(transaction.livePath).nlink).toBe(1);
    expect(fs.statSync(alias).nlink).toBe(1);
  });

  it("finishes an interrupted uninstall idempotently", () => {
    const root = temporaryDirectory();
    const { dataRoot, original, target, transaction } = installedFixture(root);
    const chmod = vi.spyOn(fs, "chmodSync").mockImplementationOnce(() => {
      throw new Error("simulated interruption");
    });

    expect(() => uninstallAll(dataRoot, [target])).toThrow(/simulated interruption/);
    chmod.mockRestore();
    expect(recoverTransactions(dataRoot)).toEqual(["Discord"]);
    expect(recoverTransactions(dataRoot)).toEqual([]);
    expect(fs.readFileSync(transaction.livePath)).toEqual(original);
    expect(inspectTarget(target).state).toBe("vanilla");
  });

  it("truncates a torn uninstall tail before appending recovery phases", () => {
    const root = temporaryDirectory();
    const { dataRoot, original, target, transaction } = installedFixture(root);
    const rename = fs.renameSync.bind(fs);
    const interrupted = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (source === transaction.livePath && path.basename(String(destination)).startsWith(".golive-loader-")) {
        throw new Error("simulated loader move interruption");
      }
      rename(source, destination);
    });

    expect(() => uninstallAll(dataRoot, [target])).toThrow(/simulated loader move interruption/);
    interrupted.mockRestore();
    fs.appendFileSync(journalPath(dataRoot, transaction.id), '{"phase":"loader');

    expect(recoverTransactions(dataRoot)).toEqual(["Discord"]);
    expect(fs.readFileSync(transaction.livePath)).toEqual(original);
    expect(inspectTarget(target).state).toBe("vanilla");
  });
});
