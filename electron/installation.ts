import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = 1;
const OWNER_FILE = ".golivebypass-owner.json";
const ORIGINAL_NAME = "app.golive-original.asar";
const LEGACY_ORIGINAL_NAME = "app.asar.golive-original";
const FOREIGN_ORIGINAL_NAME = "_app.asar";

export const DISCORD_FLAVOURS = ["Discord", "DiscordPTB", "DiscordCanary"] as const;

export type TargetState = "vanilla" | "installed" | "foreign" | "broken";

export interface DiscordTarget {
  flavour: (typeof DISCORD_FLAVOURS)[number];
  version: string;
  resourcesPath: string;
  executablePath: string;
}

export interface TargetStatus extends DiscordTarget {
  state: TargetState;
  detail: string;
}

export interface InstallationRecord {
  schema: number;
  id: string;
  flavour: DiscordTarget["flavour"];
  version: string;
  resourcesPath: string;
  executablePath: string;
  originalSha256: string;
  originalMode: number;
  originalMtimeMs: number;
  backupPath: string;
  installedAt: string;
}

interface InstallTransaction extends InstallationRecord {
  operation: "install";
  livePath: string;
  originalPath: string;
  stagePath: string;
  recordPath: string;
}

interface UninstallTransaction extends InstallationRecord {
  operation: "uninstall";
  livePath: string;
  originalPath: string;
  restoreStagePath: string;
  loaderTrashPath: string;
  recordPath: string;
}

type Transaction = InstallTransaction | UninstallTransaction;

interface JournalEvent {
  phase: string;
  transaction?: Transaction;
}

function withNoAsar<T>(operation: () => T): T {
  const electronProcess = process as NodeJS.Process & { noAsar?: boolean };
  const previous = electronProcess.noAsar;
  electronProcess.noAsar = true;
  try {
    return operation();
  } finally {
    electronProcess.noAsar = previous;
  }
}

function normalize(file: string): string {
  return path.resolve(file).toLowerCase();
}

function recordId(resourcesPath: string): string {
  return createHash("sha256").update(normalize(resourcesPath)).digest("hex").slice(0, 24);
}

function hashFile(file: string): string {
  return withNoAsar(() => {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const descriptor = fs.openSync(file, "r");
    try {
      for (;;) {
        const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      fs.closeSync(descriptor);
    }
    return hash.digest("hex");
  });
}

function writeFileDurably(file: string, content: string, flag: "w" | "a" = "w"): void {
  const descriptor = fs.openSync(file, flag);
  try {
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileDurably(file, `${JSON.stringify(value, null, 2)}\n`);
}

function appendJournal(file: string, event: JournalEvent): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileDurably(file, `${JSON.stringify(event)}\n`, "a");
}

function readJournal(file: string): { transaction: Transaction; phase: string } {
  const events = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JournalEvent);
  const transaction = events[0]?.transaction;
  if (transaction === undefined || transaction.schema !== SCHEMA) throw new Error("invalid transaction journal");
  return { transaction, phase: events.at(-1)?.phase ?? "planned" };
}

function ownerAt(livePath: string): { id: string; resourcesPath: string } | null {
  const marker = path.join(livePath, OWNER_FILE);
  if (!fs.existsSync(marker)) return null;
  try {
    const owner = JSON.parse(fs.readFileSync(marker, "utf8")) as Record<string, unknown>;
    return typeof owner.id === "string" && typeof owner.resourcesPath === "string"
      ? { id: owner.id, resourcesPath: owner.resourcesPath }
      : null;
  } catch {
    return null;
  }
}

function ownsLoader(livePath: string, resourcesPath: string, id: string): boolean {
  if (!fs.existsSync(livePath) || !fs.statSync(livePath).isDirectory()) return false;
  const owner = ownerAt(livePath);
  return owner !== null && owner.id === id && normalize(owner.resourcesPath) === normalize(resourcesPath);
}

function recordPaths(dataRoot: string, id: string) {
  return {
    backupPath: path.join(dataRoot, "backups", id, "app.asar"),
    recordPath: path.join(dataRoot, "installations", `${id}.json`),
    journalPath: path.join(dataRoot, "transactions", `${id}.jsonl`),
  };
}

function localOriginalPath(resourcesPath: string): string | null {
  const originalPath = path.join(resourcesPath, ORIGINAL_NAME);
  const legacyOriginalPath = path.join(resourcesPath, LEGACY_ORIGINAL_NAME);
  const originalExists = fs.existsSync(originalPath);
  const legacyExists = fs.existsSync(legacyOriginalPath);
  if (originalExists && legacyExists) throw new Error("Foram encontrados dois originais locais; nada foi alterado.");
  if (originalExists) return originalPath;
  if (legacyExists) return legacyOriginalPath;
  return null;
}

function compareVersions(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

export function discoverDiscordTargets(localAppData: string): DiscordTarget[] {
  return withNoAsar(() => {
    const targets: DiscordTarget[] = [];
    for (const flavour of DISCORD_FLAVOURS) {
      const root = path.join(localAppData, flavour);
      if (!fs.existsSync(root)) continue;
      const versions = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("app-"))
        .map((entry) => entry.name.slice(4))
        .sort(compareVersions);
      const version = versions.at(-1);
      if (version === undefined) continue;
      const appPath = path.join(root, `app-${version}`);
      const resourcesPath = path.join(appPath, "resources");
      const executablePath = path.join(appPath, `${flavour}.exe`);
      if (fs.existsSync(resourcesPath) && fs.existsSync(executablePath)) {
        targets.push({ flavour, version, resourcesPath, executablePath });
      }
    }
    return targets;
  });
}

export function inspectTarget(target: DiscordTarget): TargetStatus {
  return withNoAsar(() => {
    const livePath = path.join(target.resourcesPath, "app.asar");
    const originalPath = path.join(target.resourcesPath, ORIGINAL_NAME);
    const legacyOriginalPath = path.join(target.resourcesPath, LEGACY_ORIGINAL_NAME);
    const foreignOriginal = path.join(target.resourcesPath, FOREIGN_ORIGINAL_NAME);
    const id = recordId(target.resourcesPath);
    const originalExists = fs.existsSync(originalPath);
    const legacyExists = fs.existsSync(legacyOriginalPath);

    if (fs.existsSync(foreignOriginal)) {
      return { ...target, state: "foreign", detail: "Outro modificador ja usa _app.asar." };
    }
    if (ownsLoader(livePath, target.resourcesPath, id)) {
      if (originalExists !== legacyExists) {
        const detail = legacyExists
          ? "Bypass v0.1.0 detectado; Instalar ou Reparar migrara o backup local."
          : "Bypass instalado com backup local e externo.";
        return { ...target, state: "installed", detail };
      }
      return { ...target, state: "broken", detail: "O backup local esta ausente ou duplicado; use Restaurar original." };
    }
    if (originalExists || legacyExists || !fs.existsSync(livePath)) {
      return { ...target, state: "broken", detail: "Instalacao interrompida; use Reparar." };
    }
    if (!fs.statSync(livePath).isFile()) {
      return { ...target, state: "foreign", detail: "app.asar ja e um carregador de terceiros." };
    }
    return { ...target, state: "vanilla", detail: "Discord original, pronto para instalar." };
  });
}

function createLoader(stagePath: string, transaction: InstallTransaction, runtimePayloadPath: string): void {
  fs.mkdirSync(stagePath);
  writeJson(path.join(stagePath, "package.json"), { name: "discord", main: "index.js" });
  writeFileDurably(path.join(stagePath, "index.js"), `require(${JSON.stringify(runtimePayloadPath)});\n`);
  writeJson(path.join(stagePath, OWNER_FILE), {
    schema: SCHEMA,
    id: transaction.id,
    resourcesPath: transaction.resourcesPath,
    originalSha256: transaction.originalSha256,
  });
}

function rollbackInstall(transaction: InstallTransaction): void {
  if (fs.existsSync(transaction.livePath) && ownsLoader(transaction.livePath, transaction.resourcesPath, transaction.id)) {
    fs.rmSync(transaction.livePath, { recursive: true, force: true });
  }
  if (!fs.existsSync(transaction.livePath) && fs.existsSync(transaction.originalPath)) {
    fs.renameSync(transaction.originalPath, transaction.livePath);
  }
  fs.rmSync(transaction.stagePath, { recursive: true, force: true });
}

export function installTarget(target: DiscordTarget, dataRoot: string, runtimePayloadPath: string): InstallationRecord {
  return withNoAsar(() => {
    if (!path.isAbsolute(runtimePayloadPath) || !fs.existsSync(runtimePayloadPath)) {
      throw new Error("O payload local verificado nao foi encontrado.");
    }

    const status = inspectTarget(target);
    const id = recordId(target.resourcesPath);
    const paths = recordPaths(dataRoot, id);
    if (status.state === "foreign") throw new Error(`${target.flavour}: recusado para preservar o outro modificador.`);
    if (status.state === "broken") throw new Error(`${target.flavour}: execute a recuperacao antes de instalar.`);
    if (status.state === "installed") {
      const record = JSON.parse(fs.readFileSync(paths.recordPath, "utf8")) as InstallationRecord;
      const localOriginal = localOriginalPath(target.resourcesPath);
      const legacyOriginalPath = path.join(target.resourcesPath, LEGACY_ORIGINAL_NAME);
      const correctedOriginalPath = path.join(target.resourcesPath, ORIGINAL_NAME);
      if (localOriginal === legacyOriginalPath) {
        if (hashFile(localOriginal) !== record.originalSha256) throw new Error("O backup local v0.1.0 nao confere.");
        fs.renameSync(localOriginal, correctedOriginalPath);
      }
      return record;
    }

    const livePath = path.join(target.resourcesPath, "app.asar");
    const originalPath = path.join(target.resourcesPath, ORIGINAL_NAME);
    const stagePath = path.join(target.resourcesPath, `.golive-staging-${randomUUID()}`);
    const originalStat = fs.statSync(livePath);
    const originalSha256 = hashFile(livePath);
    const transaction: InstallTransaction = {
      schema: SCHEMA,
      operation: "install",
      id,
      ...target,
      originalSha256,
      originalMode: originalStat.mode,
      originalMtimeMs: originalStat.mtimeMs,
      backupPath: paths.backupPath,
      installedAt: new Date().toISOString(),
      livePath,
      originalPath,
      stagePath,
      recordPath: paths.recordPath,
    };

    fs.rmSync(paths.journalPath, { force: true });
    appendJournal(paths.journalPath, { phase: "planned", transaction });
    try {
      fs.mkdirSync(path.dirname(paths.backupPath), { recursive: true });
      if (fs.existsSync(paths.backupPath)) {
        if (hashFile(paths.backupPath) !== originalSha256) throw new Error("O backup externo existente nao confere.");
      } else {
        fs.copyFileSync(livePath, paths.backupPath, fs.constants.COPYFILE_EXCL);
        if (hashFile(paths.backupPath) !== originalSha256) throw new Error("A copia de seguranca nao confere.");
      }
      appendJournal(paths.journalPath, { phase: "backed_up" });

      createLoader(stagePath, transaction, runtimePayloadPath);
      appendJournal(paths.journalPath, { phase: "staged" });
      fs.renameSync(livePath, originalPath);
      appendJournal(paths.journalPath, { phase: "original_moved" });
      fs.renameSync(stagePath, livePath);
      writeJson(paths.recordPath, transaction);
      appendJournal(paths.journalPath, { phase: "committed" });
      fs.rmSync(paths.journalPath, { force: true });
      return transaction;
    } catch (error) {
      rollbackInstall(transaction);
      if (fs.existsSync(livePath) && hashFile(livePath) === originalSha256) {
        fs.rmSync(paths.journalPath, { force: true });
      }
      throw error;
    }
  });
}

function readRecords(dataRoot: string): InstallationRecord[] {
  const directory = path.join(dataRoot, "installations");
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")) as InstallationRecord;
        return record.schema === SCHEMA ? [record] : [];
      } catch {
        return [];
      }
    });
}

function finalizeRestoredFile(record: InstallationRecord, livePath: string): void {
  if (hashFile(livePath) !== record.originalSha256) throw new Error("O Discord restaurado nao confere com o original.");
  fs.chmodSync(livePath, record.originalMode);
  const modified = new Date(record.originalMtimeMs);
  fs.utimesSync(livePath, modified, modified);
}

export function uninstallAll(dataRoot: string): string[] {
  return withNoAsar(() => {
    const restored: string[] = [];
    for (const record of readRecords(dataRoot)) {
      const paths = recordPaths(dataRoot, record.id);
      const livePath = path.join(record.resourcesPath, "app.asar");
      const originalPath = localOriginalPath(record.resourcesPath) ?? path.join(record.resourcesPath, ORIGINAL_NAME);
      if (!fs.existsSync(record.resourcesPath)) continue;
      if (fs.existsSync(livePath) && !ownsLoader(livePath, record.resourcesPath, record.id)) {
        throw new Error(`${record.flavour}: app.asar mudou desde a instalacao; nada foi removido.`);
      }

      const restoreStagePath = path.join(record.resourcesPath, `.golive-restore-${randomUUID()}`);
      const loaderTrashPath = path.join(record.resourcesPath, `.golive-loader-${randomUUID()}`);
      const transaction: UninstallTransaction = {
        ...record,
        operation: "uninstall",
        livePath,
        originalPath,
        restoreStagePath,
        loaderTrashPath,
        recordPath: paths.recordPath,
      };
      fs.rmSync(paths.journalPath, { force: true });
      appendJournal(paths.journalPath, { phase: "planned", transaction });

      let restoreSource = originalPath;
      if (!fs.existsSync(originalPath)) {
        if (!fs.existsSync(record.backupPath) || hashFile(record.backupPath) !== record.originalSha256) {
          throw new Error(`${record.flavour}: os dois backups do Discord estao ausentes ou invalidos.`);
        }
        fs.copyFileSync(record.backupPath, restoreStagePath, fs.constants.COPYFILE_EXCL);
        restoreSource = restoreStagePath;
      }
      if (hashFile(restoreSource) !== record.originalSha256) throw new Error(`${record.flavour}: backup invalido.`);
      appendJournal(paths.journalPath, { phase: "restore_prepared" });

      if (fs.existsSync(livePath)) fs.renameSync(livePath, loaderTrashPath);
      appendJournal(paths.journalPath, { phase: "loader_moved" });
      fs.renameSync(restoreSource, livePath);
      appendJournal(paths.journalPath, { phase: "restored" });
      finalizeRestoredFile(record, livePath);
      fs.rmSync(loaderTrashPath, { recursive: true, force: true });
      fs.rmSync(paths.recordPath, { force: true });
      fs.rmSync(paths.journalPath, { force: true });
      restored.push(record.flavour);
    }
    return restored;
  });
}

export function recoverTransactions(dataRoot: string): string[] {
  return withNoAsar(() => {
    const directory = path.join(dataRoot, "transactions");
    if (!fs.existsSync(directory)) return [];
    const recovered: string[] = [];

    for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith(".jsonl"))) {
      const journalPath = path.join(directory, name);
      const { transaction } = readJournal(journalPath);
      if (transaction.operation === "install") {
        const originalPath = fs.existsSync(transaction.originalPath)
          ? transaction.originalPath
          : localOriginalPath(transaction.resourcesPath);
        if (ownsLoader(transaction.livePath, transaction.resourcesPath, transaction.id)) {
          if (originalPath === null) throw new Error(`${transaction.flavour}: o original sumiu.`);
          writeJson(transaction.recordPath, transaction);
        } else if (!fs.existsSync(transaction.livePath) && originalPath !== null) {
          fs.renameSync(originalPath, transaction.livePath);
        } else if (fs.existsSync(transaction.livePath) && hashFile(transaction.livePath) !== transaction.originalSha256) {
          throw new Error(`${transaction.flavour}: recuperacao recusada porque app.asar mudou.`);
        }
        fs.rmSync(transaction.stagePath, { recursive: true, force: true });
      } else {
        if (fs.existsSync(transaction.livePath) && ownsLoader(transaction.livePath, transaction.resourcesPath, transaction.id)) {
          fs.rmSync(transaction.restoreStagePath, { force: true });
          fs.rmSync(journalPath, { force: true });
          recovered.push(transaction.flavour);
          continue;
        }
        if (!fs.existsSync(transaction.livePath)) {
          const localOriginal = localOriginalPath(transaction.resourcesPath);
          let source: string | null = fs.existsSync(transaction.originalPath) ? transaction.originalPath : localOriginal;
          if (source === null && fs.existsSync(transaction.restoreStagePath)) source = transaction.restoreStagePath;
          if (source !== null) {
            fs.renameSync(source, transaction.livePath);
          } else if (fs.existsSync(transaction.loaderTrashPath)) {
            fs.renameSync(transaction.loaderTrashPath, transaction.livePath);
          } else {
            throw new Error(`${transaction.flavour}: nao ha arquivo para concluir a recuperacao.`);
          }
        }
        if (!fs.statSync(transaction.livePath).isFile() || hashFile(transaction.livePath) !== transaction.originalSha256) {
          throw new Error(`${transaction.flavour}: o arquivo recuperado nao confere.`);
        }
        finalizeRestoredFile(transaction, transaction.livePath);
        fs.rmSync(transaction.loaderTrashPath, { recursive: true, force: true });
        fs.rmSync(transaction.recordPath, { force: true });
      }
      fs.rmSync(journalPath, { force: true });
      recovered.push(transaction.flavour);
    }
    return recovered;
  });
}

export function installedRecords(dataRoot: string): InstallationRecord[] {
  return withNoAsar(() => readRecords(dataRoot));
}
