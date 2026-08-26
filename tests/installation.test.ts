import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverAllDiscordTargets,
  discoverDiscordTargets,
  inspectTarget,
  installTarget,
  installedRecords,
  recoverTransactions,
  uninstallAll,
  withInstallationLock,
  type DiscordTarget,
  type InstallationRecord,
} from "../electron/installation.js";

type InstallTransaction = InstallationRecord & {
  operation: "install";
  livePath: string;
  originalPath: string;
  stagePath: string;
  recordPath: string;
};

const INSTALL_PHASES = ["planned", "backed_up", "staged", "original_moved", "committed"];
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "golive-safe-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeDiscord(root: string, version = "1.0.100"): { target: DiscordTarget; original: Buffer } {
  const appRoot = path.join(root, "Discord", `app-${version}`);
  const resourcesPath = path.join(appRoot, "resources");
  fs.mkdirSync(resourcesPath, { recursive: true });
  fs.writeFileSync(path.join(appRoot, "Discord.exe"), "fake executable");
  const original = Buffer.from(`original discord ${version}\n`);
  fs.writeFileSync(path.join(resourcesPath, "app.asar"), original);
  return {
    target: { flavour: "Discord", version, resourcesPath, executablePath: path.join(appRoot, "Discord.exe") },
    original,
  };
}

function fakePayload(dataRoot: string): string {
  const payload = path.join(dataRoot, "runtime", "payload.cjs");
  fs.mkdirSync(path.dirname(payload), { recursive: true });
  fs.writeFileSync(payload, "module.exports = {};\n");
  return payload;
}

function installedFixture(root: string): {
  dataRoot: string;
  original: Buffer;
  payload: string;
  target: DiscordTarget;
  transaction: InstallTransaction;
} {
  const dataRoot = path.join(root, "data");
  const { target, original } = fakeDiscord(root);
  const payload = fakePayload(dataRoot);
  const transaction = installTarget(target, dataRoot, payload) as InstallTransaction;
  return { dataRoot, original, payload, target, transaction };
}

function recordPath(dataRoot: string, id: string): string {
  return path.join(dataRoot, "installations", `${id}.json`);
}

function journalPath(dataRoot: string, id: string): string {
  return path.join(dataRoot, "transactions", `${id}.jsonl`);
}

function writeInstallJournal(
  dataRoot: string,
  transaction: InstallTransaction | Record<string, unknown>,
  phases: string[],
  tornTail = "",
): string {
  const id = transaction.id;
  if (typeof id !== "string") throw new Error("transaction id is required");
  const journal = journalPath(dataRoot, id);
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  const events = phases.map((phase, index) =>
    JSON.stringify(index === 0 ? { phase, transaction } : { phase }),
  );
  fs.writeFileSync(journal, `${events.join("\n")}\n${tornTail}`);
  return journal;
}

function persistLegacyOriginalPath(dataRoot: string, legacyOriginalPath: string): string {
  const installations = path.join(dataRoot, "installations");
  const names = fs.readdirSync(installations);
  if (names.length !== 1 || names[0] === undefined) throw new Error("expected one installation record");
  const file = path.join(installations, names[0]);
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  record.originalPath = legacyOriginalPath;
  fs.writeFileSync(file, JSON.stringify(record));
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Discord discovery", () => {
  it("selects numeric versions instead of lexical order", () => {
    const root = temporaryDirectory();
    fakeDiscord(root, "1.0.99");
    fakeDiscord(root, "1.0.100");
    expect(discoverDiscordTargets(root)).toHaveLength(1);
    expect(discoverDiscordTargets(root)[0]?.version).toBe("1.0.100");
    expect(discoverAllDiscordTargets(root).map((target) => target.version)).toEqual(["1.0.99", "1.0.100"]);
  });

  it("rejects a junction used as a Discord root", () => {
    if (process.platform !== "win32") return;
    const root = temporaryDirectory();
    const physicalLocalAppData = path.join(root, "physical");
    fakeDiscord(physicalLocalAppData);
    fs.symlinkSync(path.join(physicalLocalAppData, "Discord"), path.join(root, "Discord"), "junction");

    expect(() => discoverDiscordTargets(root)).toThrow(/Link|nova analise/);
  });
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

describe("installation operation lock", () => {
  it("rejects a concurrent manager or uninstall helper", async () => {
    let entered!: () => void;
    let release!: () => void;
    const active = withInstallationLock(
      () =>
        new Promise<void>((resolve) => {
          entered();
          release = resolve;
        }),
    );
    await new Promise<void>((resolve) => {
      entered = resolve;
    });

    const client = net.createConnection("\\\\.\\pipe\\golivebypass-safe-installation-v1");
    await new Promise<void>((resolve, reject) => {
      client.once("close", () => resolve());
      client.once("error", reject);
    });

    await expect(withInstallationLock(() => undefined)).rejects.toThrow(/Outra operacao/);
    release();
    await Promise.race([
      active,
      new Promise((_, reject) => setTimeout(() => reject(new Error("installation lock did not close")), 1000)),
    ]);
  });

  it("creates the first journal exclusively without replacing pending evidence", () => {
    const root = temporaryDirectory();
    const { dataRoot, payload, target, transaction } = installedFixture(root);
    fs.writeFileSync(path.join(transaction.livePath, "index.js"), "modified\n");
    const journal = journalPath(dataRoot, transaction.id);
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(journal, "pending evidence\n");

    expect(() => installTarget(target, dataRoot, payload)).toThrow();
    expect(fs.readFileSync(journal, "utf8")).toBe("pending evidence\n");
  });
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
