import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  installTarget,
  type DiscordTarget,
  type InstallationRecord,
} from "../electron/installation.js";

export type InstallTransaction = InstallationRecord & {
  operation: "install";
  livePath: string;
  originalPath: string;
  stagePath: string;
  recordPath: string;
};

export const INSTALL_PHASES = ["planned", "backed_up", "staged", "original_moved", "committed"];
const temporaryDirectories: string[] = [];

export function temporaryDirectory(): string {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "golive-safe-test-")));
  temporaryDirectories.push(directory);
  return directory;
}

export function cleanupTemporaryDirectories(): void {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
}

export function fakeDiscord(root: string, version = "1.0.100"): { target: DiscordTarget; original: Buffer } {
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

export function fakePayload(dataRoot: string): string {
  const payload = path.join(dataRoot, "runtime", "payload.cjs");
  fs.mkdirSync(path.dirname(payload), { recursive: true });
  fs.writeFileSync(payload, "module.exports = {};\n");
  return payload;
}

export function installedFixture(root: string): {
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

export function recordPath(dataRoot: string, id: string): string {
  return path.join(dataRoot, "installations", `${id}.json`);
}

export function journalPath(dataRoot: string, id: string): string {
  return path.join(dataRoot, "transactions", `${id}.jsonl`);
}

export function writeInstallJournal(
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

export function persistLegacyOriginalPath(dataRoot: string, legacyOriginalPath: string): string {
  const installations = path.join(dataRoot, "installations");
  const names = fs.readdirSync(installations);
  if (names.length !== 1 || names[0] === undefined) throw new Error("expected one installation record");
  const file = path.join(installations, names[0]);
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  record.originalPath = legacyOriginalPath;
  fs.writeFileSync(file, JSON.stringify(record));
  return file;
}
