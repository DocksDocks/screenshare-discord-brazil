import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectTarget,
  installedRecords,
  recoverTransactions,
  uninstallAll,
} from "../electron/installation.js";
import {
  cleanupTemporaryDirectories,
  INSTALL_PHASES,
  installedFixture,
  journalPath,
  temporaryDirectory,
  writeInstallJournal,
} from "./installation-fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTemporaryDirectories();
});

describe("transaction recovery", () => {
  it("rolls back a crash after moving the original", () => {
    const root = temporaryDirectory();
    const { dataRoot, original, target, transaction } = installedFixture(root);
    fs.rmSync(transaction.livePath, { recursive: true });
    fs.rmSync(transaction.recordPath);
    writeInstallJournal(dataRoot, transaction, INSTALL_PHASES.slice(0, 4));

    expect(recoverTransactions(dataRoot)).toEqual(["Discord"]);
    expect(fs.readFileSync(transaction.livePath)).toEqual(original);
    expect(inspectTarget(target).state).toBe("vanilla");
    expect(fs.existsSync(transaction.backupPath)).toBe(false);

    fs.renameSync(transaction.livePath, path.join(target.resourcesPath, "_app.asar"));
    fs.mkdirSync(transaction.livePath);
    fs.writeFileSync(path.join(transaction.livePath, "index.js"), "require('foreign-mod');\n");
    expect(uninstallAll(dataRoot, [target])).toEqual([]);
  });

  it("uses the valid external backup when the moved local original is corrupt", () => {
    const root = temporaryDirectory();
    const { dataRoot, original, transaction } = installedFixture(root);
    fs.rmSync(transaction.livePath, { recursive: true });
    fs.writeFileSync(transaction.originalPath, "corrupt local original");
    fs.rmSync(transaction.recordPath);
    writeInstallJournal(dataRoot, transaction, INSTALL_PHASES.slice(0, 4));

    expect(recoverTransactions(dataRoot)).toEqual(["Discord"]);
    expect(fs.readFileSync(transaction.livePath)).toEqual(original);
    expect(fs.existsSync(transaction.originalPath)).toBe(false);
  });

  it("preserves the journal when neither original candidate is valid", () => {
    const root = temporaryDirectory();
    const { dataRoot, transaction } = installedFixture(root);
    fs.rmSync(transaction.livePath, { recursive: true });
    fs.writeFileSync(transaction.originalPath, "corrupt local original");
    fs.writeFileSync(transaction.backupPath, "corrupt external backup");
    fs.rmSync(transaction.recordPath);
    const journal = writeInstallJournal(dataRoot, transaction, INSTALL_PHASES.slice(0, 4));

    expect(() => recoverTransactions(dataRoot)).toThrow(/backups|recuperado/);
    expect(fs.existsSync(journal)).toBe(true);
  });

  it("recovers a v0.1.0 journal after its local archive name was migrated", () => {
    const root = temporaryDirectory();
    const { dataRoot, original, target, transaction } = installedFixture(root);
    transaction.originalPath = path.join(target.resourcesPath, "app.asar.golive-original");
    fs.rmSync(transaction.livePath, { recursive: true });
    fs.rmSync(transaction.recordPath);
    writeInstallJournal(dataRoot, transaction, INSTALL_PHASES.slice(0, 4));

    expect(recoverTransactions(dataRoot)).toEqual(["Discord"]);
    expect(fs.readFileSync(transaction.livePath)).toEqual(original);
    expect(inspectTarget(target).state).toBe("vanilla");
  });

  it("rebuilds the installation record after a committed-loader crash", () => {
    const root = temporaryDirectory();
    const { dataRoot, target, transaction } = installedFixture(root);
    fs.rmSync(transaction.recordPath);
    writeInstallJournal(dataRoot, transaction, INSTALL_PHASES);

    expect(recoverTransactions(dataRoot)).toEqual(["Discord"]);
    expect(installedRecords(dataRoot)).toHaveLength(1);
    expect(inspectTarget(target).state).toBe("installed");
  });

  it("tolerates only a torn final journal line", () => {
    const root = temporaryDirectory();
    const { dataRoot, original, transaction } = installedFixture(root);
    fs.rmSync(transaction.livePath, { recursive: true });
    fs.rmSync(transaction.recordPath);
    writeInstallJournal(dataRoot, transaction, INSTALL_PHASES.slice(0, 4), '{"phase":"comm');

    expect(recoverTransactions(dataRoot)).toEqual(["Discord"]);
    expect(fs.readFileSync(transaction.livePath)).toEqual(original);
  });

  it("rejects a malformed middle event", () => {
    const root = temporaryDirectory();
    const { dataRoot, transaction } = installedFixture(root);
    const journal = journalPath(dataRoot, transaction.id);
    fs.writeFileSync(
      journal,
      `${JSON.stringify({ phase: "planned", transaction })}\nnot json\n${JSON.stringify({ phase: "backed_up" })}\n`,
    );

    expect(() => recoverTransactions(dataRoot)).toThrow(/Journal de transacao invalido/);
    expect(fs.existsSync(journal)).toBe(true);
  });

  it("rejects an inconsistent phase sequence", () => {
    const root = temporaryDirectory();
    const { dataRoot, transaction } = installedFixture(root);
    const journal = writeInstallJournal(dataRoot, transaction, ["planned", "staged"]);

    expect(() => recoverTransactions(dataRoot)).toThrow(/Sequencia de fases invalida/);
    expect(fs.existsSync(journal)).toBe(true);
  });

  it("rejects a transaction path outside its trusted roots before mutation", () => {
    const root = temporaryDirectory();
    const { dataRoot, target, transaction } = installedFixture(root);
    const outside = path.join(root, "outside-stage");
    fs.writeFileSync(outside, "sentinel");
    const crafted = { ...transaction, stagePath: outside };
    const journal = writeInstallJournal(dataRoot, crafted, INSTALL_PHASES.slice(0, 4));

    expect(() => recoverTransactions(dataRoot)).toThrow(/Journal de transacao invalido/);
    expect(fs.readFileSync(outside, "utf8")).toBe("sentinel");
    expect(inspectTarget(target).state).toBe("installed");
    expect(fs.existsSync(journal)).toBe(true);
  });

  it("rejects a journal whose filename does not match its transaction id", () => {
    const root = temporaryDirectory();
    const { dataRoot, transaction } = installedFixture(root);
    const originalJournal = writeInstallJournal(dataRoot, transaction, INSTALL_PHASES);
    const mismatchedId = transaction.id === "0".repeat(24) ? "1".repeat(24) : "0".repeat(24);
    fs.renameSync(originalJournal, journalPath(dataRoot, mismatchedId));

    expect(() => recoverTransactions(dataRoot)).toThrow(/Journal de transacao invalido/);
  });
});
