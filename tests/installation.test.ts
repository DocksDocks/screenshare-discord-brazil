import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverDiscordTargets,
  inspectTarget,
  installTarget,
  installedRecords,
  recoverTransactions,
  uninstallAll,
  type DiscordTarget,
  type InstallationRecord,
} from "../electron/installation.js";

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

function fakePayload(root: string): string {
  const payload = path.join(root, "runtime", "payload.cjs");
  fs.mkdirSync(path.dirname(payload), { recursive: true });
  fs.writeFileSync(payload, "module.exports = {};\n");
  return payload;
}

function persistLegacyOriginalPath(dataRoot: string, legacyOriginalPath: string): string {
  const installations = path.join(dataRoot, "installations");
  const names = fs.readdirSync(installations);
  if (names.length !== 1 || names[0] === undefined) throw new Error("expected one installation record");
  const recordPath = path.join(installations, names[0]);
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8")) as Record<string, unknown>;
  record.originalPath = legacyOriginalPath;
  fs.writeFileSync(recordPath, JSON.stringify(record));
  return recordPath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Discord discovery", () => {
  it("selects numeric versions instead of lexical order", () => {
    const root = temporaryDirectory();
    fakeDiscord(root, "1.0.99");
    fakeDiscord(root, "1.0.100");
    expect(discoverDiscordTargets(root)).toHaveLength(1);
    expect(discoverDiscordTargets(root)[0]?.version).toBe("1.0.100");
  });
});

describe("transactional installation", () => {
  it("installs with two verified originals and restores the exact bytes", () => {
    const root = temporaryDirectory();
    const dataRoot = path.join(root, "data");
    const { target, original } = fakeDiscord(root);
    const record = installTarget(target, dataRoot, fakePayload(root));

    expect(inspectTarget(target).state).toBe("installed");
    expect(fs.readFileSync(record.backupPath)).toEqual(original);
    expect(fs.readFileSync(path.join(target.resourcesPath, "app.golive-original.asar"))).toEqual(original);
    expect(fs.statSync(path.join(target.resourcesPath, "app.asar")).isDirectory()).toBe(true);

    expect(uninstallAll(dataRoot, [target])).toEqual(["Discord"]);
    expect(fs.readFileSync(path.join(target.resourcesPath, "app.asar"))).toEqual(original);
    expect(inspectTarget(target).state).toBe("vanilla");
    expect(installedRecords(dataRoot)).toEqual([]);
  });

  it("migrates a v0.1.0 local backup to an Electron-readable ASAR name", () => {
    const root = temporaryDirectory();
    const dataRoot = path.join(root, "data");
    const { target, original } = fakeDiscord(root);
    const payload = fakePayload(root);
    installTarget(target, dataRoot, payload);
    const corrected = path.join(target.resourcesPath, "app.golive-original.asar");
    const legacy = path.join(target.resourcesPath, "app.asar.golive-original");
    fs.renameSync(corrected, legacy);
    const recordPath = persistLegacyOriginalPath(dataRoot, legacy);

    expect(inspectTarget(target).state).toBe("installed");
    installTarget(target, dataRoot, payload);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(corrected)).toEqual(original);
    expect(JSON.parse(fs.readFileSync(recordPath, "utf8")).originalPath).toBe(legacy);
  });

  it("restores a v0.1.0 local backup directly", () => {
    const root = temporaryDirectory();
    const dataRoot = path.join(root, "data");
    const { target, original } = fakeDiscord(root);
    installTarget(target, dataRoot, fakePayload(root));
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
    expect(() => installTarget(target, dataRoot, fakePayload(root))).toThrow(/preservar o outro modificador/);
    expect(fs.readFileSync(path.join(live, "index.js"), "utf8")).toBe("require('vencord');\n");
  });

  it("refuses to finish restoration when its installation record is missing", () => {
    const root = temporaryDirectory();
    const dataRoot = path.join(root, "data");
    const { target } = fakeDiscord(root);
    const record = installTarget(target, dataRoot, fakePayload(root));
    fs.rmSync(path.join(dataRoot, "installations", `${record.id}.json`));

    expect(() => uninstallAll(dataRoot, [target])).toThrow(/continua modificado/);
    expect(inspectTarget(target).state).toBe("installed");
  });

  it("refuses to ignore a corrupt installation record", () => {
    const root = temporaryDirectory();
    const dataRoot = path.join(root, "data");
    const { target } = fakeDiscord(root);
    const record = installTarget(target, dataRoot, fakePayload(root));
    fs.writeFileSync(path.join(dataRoot, "installations", `${record.id}.json`), "not json");

    expect(() => uninstallAll(dataRoot, [target])).toThrow(/Registro de instalacao invalido/);
    expect(inspectTarget(target).state).toBe("installed");
  });

  it("rolls back a crash after moving the original", () => {
    const root = temporaryDirectory();
    const dataRoot = path.join(root, "data");
    const { target, original } = fakeDiscord(root);
    const transaction = installTarget(target, dataRoot, fakePayload(root)) as InstallationRecord & {
      operation: "install";
      livePath: string;
      originalPath: string;
      stagePath: string;
      recordPath: string;
    };

    fs.rmSync(transaction.livePath, { recursive: true });
    fs.rmSync(transaction.recordPath);
    const journal = path.join(dataRoot, "transactions", `${transaction.id}.jsonl`);
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(
      journal,
      `${JSON.stringify({ phase: "planned", transaction })}\n${JSON.stringify({ phase: "original_moved" })}\n`,
    );

    expect(recoverTransactions(dataRoot)).toEqual(["Discord"]);
    expect(fs.readFileSync(transaction.livePath)).toEqual(original);
    expect(inspectTarget(target).state).toBe("vanilla");
  });

  it("recovers a v0.1.0 install journal after its local archive name was migrated", () => {
    const root = temporaryDirectory();
    const dataRoot = path.join(root, "data");
    const { target, original } = fakeDiscord(root);
    const transaction = installTarget(target, dataRoot, fakePayload(root)) as InstallationRecord & {
      operation: "install";
      livePath: string;
      originalPath: string;
      stagePath: string;
      recordPath: string;
    };
    transaction.originalPath = path.join(target.resourcesPath, "app.asar.golive-original");
    fs.rmSync(transaction.livePath, { recursive: true });
    fs.rmSync(transaction.recordPath);
    const journal = path.join(dataRoot, "transactions", `${transaction.id}.jsonl`);
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(
      journal,
      `${JSON.stringify({ phase: "planned", transaction })}\n${JSON.stringify({ phase: "original_moved" })}\n`,
    );

    expect(recoverTransactions(dataRoot)).toEqual(["Discord"]);
    expect(fs.readFileSync(transaction.livePath)).toEqual(original);
    expect(inspectTarget(target).state).toBe("vanilla");
  });

  it("rebuilds the installation record after a committed-loader crash", () => {
    const root = temporaryDirectory();
    const dataRoot = path.join(root, "data");
    const { target } = fakeDiscord(root);
    const transaction = installTarget(target, dataRoot, fakePayload(root)) as InstallationRecord & {
      operation: "install";
      livePath: string;
      originalPath: string;
      stagePath: string;
      recordPath: string;
    };
    fs.rmSync(transaction.recordPath);
    const journal = path.join(dataRoot, "transactions", `${transaction.id}.jsonl`);
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(
      journal,
      `${JSON.stringify({ phase: "planned", transaction })}\n${JSON.stringify({ phase: "committed" })}\n`,
    );

    expect(recoverTransactions(dataRoot)).toEqual(["Discord"]);
    expect(installedRecords(dataRoot)).toHaveLength(1);
    expect(inspectTarget(target).state).toBe("installed");
  });
});
