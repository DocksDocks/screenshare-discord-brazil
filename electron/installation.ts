import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const SCHEMA = 1;
const OWNER_FILE = ".golivebypass-owner.json";
const ORIGINAL_NAME = "app.golive-original.asar";
const LEGACY_ORIGINAL_NAME = "app.asar.golive-original";
const FOREIGN_ORIGINAL_NAME = "_app.asar";
const ID_PATTERN = /^[a-f0-9]{24}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PACKAGE_CONTENT = `${JSON.stringify({ name: "discord", main: "index.js" }, null, 2)}\n`;
const RECORD_KEYS = [
  "schema",
  "id",
  "flavour",
  "version",
  "resourcesPath",
  "executablePath",
  "originalSha256",
  "originalMode",
  "originalMtimeMs",
  "backupPath",
  "installedAt",
] as const;
const INSTALL_TRANSACTION_KEYS = [
  ...RECORD_KEYS,
  "operation",
  "livePath",
  "originalPath",
  "stagePath",
  "recordPath",
] as const;
const UNINSTALL_TRANSACTION_KEYS = [
  ...RECORD_KEYS,
  "operation",
  "livePath",
  "originalPath",
  "restoreStagePath",
  "loaderTrashPath",
  "recordPath",
] as const;
const INSTALL_PHASES = ["planned", "backed_up", "staged", "original_moved", "committed"] as const;
const UNINSTALL_PHASES = ["planned", "restore_prepared", "loader_moved", "restored"] as const;
const INSTALLATION_LOCK_PIPE = "\\\\.\\pipe\\golivebypass-safe-installation-v1";

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

interface LoaderIdentity {
  schema: number;
  id: string;
  resourcesPath: string;
  originalSha256: string;
  runtimePayloadPath?: string;
  loaderSha256?: string;
}

interface LoaderOwner extends LoaderIdentity {
  schema: typeof SCHEMA;
  runtimePayloadPath: string;
  loaderSha256: string;
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
  return path.resolve(file).replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function samePath(left: string, right: string): boolean {
  return normalize(left) === normalize(right);
}

export async function withInstallationLock<T>(operation: () => T | Promise<T>): Promise<T> {
  const clients = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    socket.destroy();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => reject(error);
      server.once("error", onError);
      server.listen(INSTALLATION_LOCK_PIPE, () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (error) {
    if (server.listening) server.close();
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error("Outra operacao do GoLiveBypass Safe esta em andamento.");
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    for (const client of clients) client.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}

function recordId(resourcesPath: string): string {
  return createHash("sha256").update(normalize(resourcesPath)).digest("hex").slice(0, 24);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertCanonicalPath(file: string): void {
  if (!path.isAbsolute(file) || file.includes("\0") || path.resolve(file) !== file) {
    throw new Error(`Caminho nao canonico recusado: ${file}.`);
  }
}

function assertNoReparse(file: string): void {
  assertCanonicalPath(file);
  const root = path.parse(file).root;
  let current = root;
  let currentStat = fs.lstatSync(current, { throwIfNoEntry: false });
  if (currentStat !== undefined) {
    if (currentStat.isSymbolicLink() || normalize(fs.realpathSync.native(current)) !== normalize(current)) {
      throw new Error(`Link ou ponto de nova analise recusado: ${current}.`);
    }
  }

  const relative = path.relative(root, file);
  const segments = relative === "" ? [] : relative.split(path.sep);
  for (const segment of segments) {
    if (currentStat === undefined) return;
    if (!currentStat.isDirectory()) throw new Error(`Ancestral de caminho nao e diretorio: ${current}.`);

    const entries = fs.readdirSync(current, { withFileTypes: true });
    const entry = entries.find((candidate) =>
      process.platform === "win32"
        ? normalize(path.join(current, candidate.name)) === normalize(path.join(current, segment))
        : candidate.name === segment,
    );
    const next = path.join(current, segment);
    if (entry === undefined) {
      if (fs.lstatSync(next, { throwIfNoEntry: false }) === undefined) return;
      throw new Error(`O caminho mudou durante a validacao: ${next}.`);
    }
    if (entry.isSymbolicLink()) throw new Error(`Link ou ponto de nova analise recusado: ${next}.`);

    currentStat = fs.lstatSync(next, { throwIfNoEntry: false });
    if (currentStat === undefined) throw new Error(`O caminho mudou durante a validacao: ${next}.`);
    if (currentStat.isSymbolicLink() || normalize(fs.realpathSync.native(next)) !== normalize(next)) {
      throw new Error(`Link ou ponto de nova analise recusado: ${next}.`);
    }
    current = next;
  }
}

function existingStat(file: string): fs.Stats | undefined {
  assertNoReparse(file);
  return fs.lstatSync(file, { throwIfNoEntry: false });
}

function assertTreeNoReparse(root: string): void {
  const stat = existingStat(root);
  if (stat === undefined || !stat.isDirectory()) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Link ou ponto de nova analise recusado: ${file}.`);
    assertNoReparse(file);
    if (entry.isDirectory()) assertTreeNoReparse(file);
  }
}

function ensureDirectory(directory: string): void {
  assertNoReparse(directory);
  fs.mkdirSync(directory, { recursive: true });
  assertNoReparse(directory);
  if (!fs.lstatSync(directory).isDirectory()) throw new Error(`Diretorio esperado nao foi criado: ${directory}.`);
}

function safeRemove(file: string, recursive = false): void {
  const stat = existingStat(file);
  if (stat === undefined) return;
  if (recursive && stat.isDirectory()) assertTreeNoReparse(file);
  fs.rmSync(file, { recursive, force: true });
}

function safeRename(source: string, destination: string): void {
  assertNoReparse(source);
  assertNoReparse(destination);
  fs.renameSync(source, destination);
  assertNoReparse(destination);
}

function safeCopy(source: string, destination: string): void {
  assertNoReparse(source);
  assertNoReparse(destination);
  ensureDirectory(path.dirname(destination));
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  const descriptor = fs.openSync(destination, "r+");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  assertNoReparse(destination);
}

function flushFile(file: string): void {
  assertNoReparse(file);
  const descriptor = fs.openSync(file, "r+");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertSingleLinkFile(file: string): void {
  const stat = existingStat(file);
  if (stat !== undefined && stat.isFile() && stat.nlink !== 1) {
    throw new Error(`Arquivo com hard link recusado: ${file}.`);
  }
}

function sameFileIdentity(left: string, right: string): boolean {
  assertNoReparse(left);
  assertNoReparse(right);
  const leftStat = fs.statSync(left, { bigint: true });
  const rightStat = fs.statSync(right, { bigint: true });
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
}

function hashFile(file: string): string {
  return withNoAsar(() => {
    assertNoReparse(file);
    if (!fs.lstatSync(file).isFile()) throw new Error(`Arquivo regular esperado: ${file}.`);
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

function writeFileDurably(file: string, content: string, flag: "w" | "a" | "wx" = "w"): void {
  assertNoReparse(file);
  const descriptor = fs.openSync(file, flag);
  try {
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJson(file: string, value: unknown): void {
  ensureDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    writeFileDurably(temporary, jsonText(value), "wx");
    safeRename(temporary, file);
    assertSingleLinkFile(file);
  } finally {
    safeRemove(temporary);
  }
}

function appendJournal(file: string, event: JournalEvent): void {
  ensureDirectory(path.dirname(file));
  assertSingleLinkFile(file);
  writeFileDurably(file, `${JSON.stringify(event)}\n`, "a");
}

function createJournal(file: string, event: JournalEvent): void {
  ensureDirectory(path.dirname(file));
  writeFileDurably(file, `${JSON.stringify(event)}\n`, "wx");
  assertSingleLinkFile(file);
}

function recordPaths(dataRoot: string, id: string) {
  return {
    backupPath: path.join(dataRoot, "backups", id, "app.asar"),
    recordPath: path.join(dataRoot, "installations", `${id}.json`),
    journalPath: path.join(dataRoot, "transactions", `${id}.jsonl`),
  };
}

function validateTargetFields(value: Record<string, unknown>, dataRoot?: string): DiscordTarget {
  if (
    !DISCORD_FLAVOURS.includes(value.flavour as DiscordTarget["flavour"]) ||
    typeof value.version !== "string" ||
    !VERSION_PATTERN.test(value.version) ||
    typeof value.resourcesPath !== "string" ||
    typeof value.executablePath !== "string"
  ) {
    throw new Error("Campos do alvo Discord invalidos.");
  }

  const target: DiscordTarget = {
    flavour: value.flavour as DiscordTarget["flavour"],
    version: value.version,
    resourcesPath: value.resourcesPath,
    executablePath: value.executablePath,
  };
  assertCanonicalPath(target.resourcesPath);
  assertCanonicalPath(target.executablePath);
  const appPath = path.dirname(target.resourcesPath);
  const flavourRoot = path.dirname(appPath);
  if (
    !samePath(target.resourcesPath, path.join(appPath, "resources")) ||
    path.basename(appPath).toLowerCase() !== `app-${target.version}`.toLowerCase() ||
    path.basename(flavourRoot).toLowerCase() !== target.flavour.toLowerCase() ||
    !samePath(target.executablePath, path.join(appPath, `${target.flavour}.exe`))
  ) {
    throw new Error("Layout do alvo Discord invalido.");
  }
  if (dataRoot !== undefined) {
    const expectedResources = path.join(
      path.dirname(dataRoot),
      target.flavour,
      `app-${target.version}`,
      "resources",
    );
    if (!samePath(target.resourcesPath, expectedResources)) throw new Error("Alvo Discord fora de LOCALAPPDATA.");
  }
  return target;
}

function validateTarget(target: DiscordTarget, dataRoot?: string): DiscordTarget {
  if (!isObject(target)) throw new Error("Alvo Discord invalido.");
  return validateTargetFields(target, dataRoot);
}

function assertTargetTopology(target: DiscordTarget): void {
  const appPath = path.dirname(target.resourcesPath);
  for (const file of [
    path.dirname(appPath),
    appPath,
    target.resourcesPath,
    target.executablePath,
    path.join(target.resourcesPath, "app.asar"),
    path.join(target.resourcesPath, ORIGINAL_NAME),
    path.join(target.resourcesPath, LEGACY_ORIGINAL_NAME),
    path.join(target.resourcesPath, FOREIGN_ORIGINAL_NAME),
  ]) {
    assertNoReparse(file);
  }
}

function assertDataRootTopology(dataRoot: string): void {
  assertCanonicalPath(dataRoot);
  for (const file of [
    dataRoot,
    path.join(dataRoot, "transactions"),
    path.join(dataRoot, "installations"),
    path.join(dataRoot, "backups"),
    path.join(dataRoot, "runtime"),
  ]) {
    assertNoReparse(file);
  }
}

function validateRecordFields(
  value: Record<string, unknown>,
  dataRoot: string,
  expectedId: string,
): InstallationRecord {
  if (
    value.schema !== SCHEMA ||
    typeof value.id !== "string" ||
    !ID_PATTERN.test(value.id) ||
    value.id !== expectedId ||
    typeof value.originalSha256 !== "string" ||
    !SHA256_PATTERN.test(value.originalSha256) ||
    !Number.isSafeInteger(value.originalMode) ||
    (value.originalMode as number) < 0 ||
    (value.originalMode as number) > 0xffffffff ||
    typeof value.originalMtimeMs !== "number" ||
    !Number.isFinite(value.originalMtimeMs) ||
    !Number.isFinite(new Date(value.originalMtimeMs).getTime()) ||
    value.originalMtimeMs < 0 ||
    typeof value.backupPath !== "string" ||
    typeof value.installedAt !== "string"
  ) {
    throw new Error("Campos do registro de instalacao invalidos.");
  }
  const installedTime = Date.parse(value.installedAt);
  if (!Number.isFinite(installedTime) || new Date(installedTime).toISOString() !== value.installedAt) {
    throw new Error("Data do registro de instalacao invalida.");
  }

  const target = validateTargetFields(value, dataRoot);
  if (recordId(target.resourcesPath) !== value.id) throw new Error("ID do registro nao corresponde ao alvo.");
  const paths = recordPaths(dataRoot, value.id);
  if (!samePath(value.backupPath, paths.backupPath)) throw new Error("Backup fora do diretorio confiavel.");
  return {
    schema: SCHEMA,
    id: value.id,
    ...target,
    originalSha256: value.originalSha256,
    originalMode: value.originalMode as number,
    originalMtimeMs: value.originalMtimeMs,
    backupPath: paths.backupPath,
    installedAt: value.installedAt,
  };
}

function validateRandomPath(value: unknown, resourcesPath: string, prefix: string): string {
  if (typeof value !== "string" || !samePath(path.dirname(value), resourcesPath)) {
    throw new Error("Caminho temporario invalido.");
  }
  const name = path.basename(value);
  const identifier = name.slice(prefix.length);
  if (!name.startsWith(prefix) || !UUID_PATTERN.test(identifier) || !samePath(value, path.join(resourcesPath, name))) {
    throw new Error("Caminho temporario invalido.");
  }
  return path.join(resourcesPath, `${prefix}${identifier}`);
}

function validateTransaction(
  value: unknown,
  dataRoot: string,
  expectedId: string,
): Transaction {
  if (!isObject(value) || (value.operation !== "install" && value.operation !== "uninstall")) {
    throw new Error("Operacao da transacao invalida.");
  }
  const expectedKeys = value.operation === "install" ? INSTALL_TRANSACTION_KEYS : UNINSTALL_TRANSACTION_KEYS;
  if (!hasExactKeys(value, expectedKeys)) throw new Error("Estrutura da transacao invalida.");

  const record = validateRecordFields(value, dataRoot, expectedId);
  const paths = recordPaths(dataRoot, record.id);
  const livePath = path.join(record.resourcesPath, "app.asar");
  const currentOriginal = path.join(record.resourcesPath, ORIGINAL_NAME);
  const legacyOriginal = path.join(record.resourcesPath, LEGACY_ORIGINAL_NAME);
  if (
    typeof value.livePath !== "string" ||
    typeof value.originalPath !== "string" ||
    typeof value.recordPath !== "string" ||
    !samePath(value.livePath, livePath) ||
    (!samePath(value.originalPath, currentOriginal) && !samePath(value.originalPath, legacyOriginal)) ||
    !samePath(value.recordPath, paths.recordPath)
  ) {
    throw new Error("Caminhos derivados da transacao invalidos.");
  }
  const originalPath = samePath(value.originalPath, currentOriginal) ? currentOriginal : legacyOriginal;

  if (value.operation === "install") {
    return {
      ...record,
      operation: "install",
      livePath,
      originalPath,
      stagePath: validateRandomPath(value.stagePath, record.resourcesPath, ".golive-staging-"),
      recordPath: paths.recordPath,
    };
  }
  return {
    ...record,
    operation: "uninstall",
    livePath,
    originalPath,
    restoreStagePath: validateRandomPath(value.restoreStagePath, record.resourcesPath, ".golive-restore-"),
    loaderTrashPath: validateRandomPath(value.loaderTrashPath, record.resourcesPath, ".golive-loader-"),
    recordPath: paths.recordPath,
  };
}

function recordFromTransaction(transaction: Transaction): InstallationRecord {
  return {
    schema: transaction.schema,
    id: transaction.id,
    flavour: transaction.flavour,
    version: transaction.version,
    resourcesPath: transaction.resourcesPath,
    executablePath: transaction.executablePath,
    originalSha256: transaction.originalSha256,
    originalMode: transaction.originalMode,
    originalMtimeMs: transaction.originalMtimeMs,
    backupPath: transaction.backupPath,
    installedAt: transaction.installedAt,
  };
}

function assertRecordTopology(record: InstallationRecord, dataRoot: string): void {
  assertTargetTopology(record);
  const paths = recordPaths(dataRoot, record.id);
  for (const file of [record.backupPath, path.dirname(record.backupPath), paths.recordPath, paths.journalPath]) {
    assertNoReparse(file);
  }
}

function assertTransactionTopology(transaction: Transaction, dataRoot: string): void {
  assertDataRootTopology(dataRoot);
  assertRecordTopology(transaction, dataRoot);
  const files =
    transaction.operation === "install"
      ? [
          transaction.livePath,
          transaction.originalPath,
          transaction.stagePath,
          path.join(transaction.resourcesPath, ".golive-repair-loader"),
          path.join(transaction.resourcesPath, ".golive-rollback-loader"),
          transaction.recordPath,
        ]
      : [
          transaction.livePath,
          transaction.originalPath,
          transaction.restoreStagePath,
          transaction.loaderTrashPath,
          transaction.recordPath,
        ];
  for (const file of files) assertNoReparse(file);
}

function parseInstallationRecord(
  value: unknown,
  dataRoot: string,
  expectedId: string,
): InstallationRecord {
  if (!isObject(value)) throw new Error("Estrutura do registro de instalacao invalida.");
  if (hasExactKeys(value, RECORD_KEYS)) return validateRecordFields(value, dataRoot, expectedId);
  if (hasExactKeys(value, INSTALL_TRANSACTION_KEYS)) {
    const transaction = validateTransaction(value, dataRoot, expectedId);
    if (transaction.operation !== "install") throw new Error("Operacao invalida no registro de instalacao.");
    return recordFromTransaction(transaction);
  }
  throw new Error("Estrutura do registro de instalacao invalida.");
}

function readRecordFile(dataRoot: string, name: string): InstallationRecord {
  const match = /^([a-f0-9]{24})\.json$/.exec(name);
  if (match?.[1] === undefined) throw new Error(`Registro de instalacao invalido: ${name}.`);
  const recordPath = path.join(dataRoot, "installations", name);
  assertNoReparse(recordPath);
  assertSingleLinkFile(recordPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  } catch {
    throw new Error(`Registro de instalacao invalido: ${name}.`);
  }
  try {
    const record = parseInstallationRecord(parsed, dataRoot, match[1]);
    assertRecordTopology(record, dataRoot);
    return record;
  } catch (error) {
    throw new Error(`Registro de instalacao invalido: ${name}.`, { cause: error });
  }
}

function readRecords(dataRoot: string): InstallationRecord[] {
  assertDataRootTopology(dataRoot);
  const directory = path.join(dataRoot, "installations");
  const stat = existingStat(directory);
  if (stat === undefined) return [];
  if (!stat.isDirectory()) throw new Error("Diretorio de registros de instalacao invalido.");
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(`Registro de instalacao invalido: ${entry.name}.`);
      }
      return readRecordFile(dataRoot, entry.name);
    });
}

function readJournal(
  file: string,
  dataRoot: string,
  name: string,
): { transaction: Transaction; phase: string } {
  const match = /^([a-f0-9]{24})\.jsonl$/.exec(name);
  if (match?.[1] === undefined) throw new Error(`Journal de transacao invalido: ${name}.`);
  assertNoReparse(file);
  assertSingleLinkFile(file);
  const bytes = fs.readFileSync(file);
  const durableLength = bytes.lastIndexOf(0x0a) + 1;
  if (durableLength === 0) throw new Error(`Journal de transacao invalido: ${name}.`);
  const content = bytes.subarray(0, durableLength).toString("utf8");
  const segments = content.split("\n");
  segments.pop();
  const lines = segments.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines.length === 0 || lines.some((line) => line === "")) {
    throw new Error(`Journal de transacao invalido: ${name}.`);
  }

  const events: Record<string, unknown>[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Journal de transacao invalido: ${name}.`);
    }
    if (!isObject(parsed)) throw new Error(`Journal de transacao invalido: ${name}.`);
    events.push(parsed);
  }
  if (!hasExactKeys(events[0]!, ["phase", "transaction"])) {
    throw new Error(`Journal de transacao invalido: ${name}.`);
  }
  if (events.slice(1).some((event) => !hasExactKeys(event, ["phase"]))) {
    throw new Error(`Journal de transacao invalido: ${name}.`);
  }

  let transaction: Transaction;
  try {
    transaction = validateTransaction(events[0]!.transaction, dataRoot, match[1]);
    assertTransactionTopology(transaction, dataRoot);
  } catch (error) {
    throw new Error(`Journal de transacao invalido: ${name}.`, { cause: error });
  }
  const expectedPhases = transaction.operation === "install" ? INSTALL_PHASES : UNINSTALL_PHASES;
  if (
    events.length > expectedPhases.length ||
    events.some((event, index) => typeof event.phase !== "string" || event.phase !== expectedPhases[index])
  ) {
    throw new Error(`Sequencia de fases invalida: ${name}.`);
  }
  if (durableLength !== bytes.length) {
    const descriptor = fs.openSync(file, "r+");
    try {
      fs.ftruncateSync(descriptor, durableLength);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }
  return { transaction, phase: events.at(-1)!.phase as string };
}

function loaderHash(
  record: Pick<InstallationRecord, "id" | "resourcesPath" | "originalSha256">,
  runtimePayloadPath: string,
): string {
  const indexContent = `require(${JSON.stringify(runtimePayloadPath)});\n`;
  const identity = JSON.stringify({
    schema: SCHEMA,
    id: record.id,
    resourcesPath: record.resourcesPath,
    originalSha256: record.originalSha256,
    runtimePayloadPath,
  });
  return createHash("sha256")
    .update(PACKAGE_CONTENT)
    .update("\0")
    .update(indexContent)
    .update("\0")
    .update(identity)
    .digest("hex");
}

function expectedOwner(
  record: Pick<InstallationRecord, "id" | "resourcesPath" | "originalSha256">,
  runtimePayloadPath: string,
): LoaderOwner {
  return {
    schema: SCHEMA,
    id: record.id,
    resourcesPath: record.resourcesPath,
    originalSha256: record.originalSha256,
    runtimePayloadPath,
    loaderSha256: loaderHash(record, runtimePayloadPath),
  };
}

function loaderIdentity(livePath: string): LoaderIdentity | null {
  const liveStat = existingStat(livePath);
  if (liveStat === undefined || !liveStat.isDirectory()) return null;
  assertTreeNoReparse(livePath);
  const marker = path.join(livePath, OWNER_FILE);
  if (existingStat(marker) === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(marker, "utf8"));
  } catch {
    return null;
  }
  if (
    !isObject(value) ||
    value.schema !== SCHEMA ||
    typeof value.id !== "string" ||
    !ID_PATTERN.test(value.id) ||
    typeof value.resourcesPath !== "string" ||
    typeof value.originalSha256 !== "string" ||
    !SHA256_PATTERN.test(value.originalSha256)
  ) {
    return null;
  }
  try {
    assertCanonicalPath(value.resourcesPath);
  } catch {
    return null;
  }
  return {
    schema: SCHEMA,
    id: value.id,
    resourcesPath: value.resourcesPath,
    originalSha256: value.originalSha256,
    runtimePayloadPath: typeof value.runtimePayloadPath === "string" ? value.runtimePayloadPath : undefined,
    loaderSha256: typeof value.loaderSha256 === "string" ? value.loaderSha256 : undefined,
  };
}

function ownsLoader(
  livePath: string,
  record: Pick<InstallationRecord, "id" | "resourcesPath">,
): boolean {
  const owner = loaderIdentity(livePath);
  return owner !== null && owner.id === record.id && samePath(owner.resourcesPath, record.resourcesPath);
}

function repairLoaderTrashPath(resourcesPath: string): string {
  return path.join(resourcesPath, ".golive-repair-loader");
}

function rollbackLoaderTrashPath(resourcesPath: string): string {
  return path.join(resourcesPath, ".golive-rollback-loader");
}

function quarantineOwnedLoader(
  livePath: string,
  trashPath: string,
  record: Pick<InstallationRecord, "id" | "resourcesPath">,
): void {
  if (existingStat(trashPath) !== undefined) {
    throw new Error("Existe um carregador de reparo pendente; execute a recuperacao primeiro.");
  }
  safeRename(livePath, trashPath);
  if (ownsLoader(trashPath, record)) return;
  if (existingStat(livePath) === undefined) safeRename(trashPath, livePath);
  throw new Error("O carregador isolado nao pertence ao GoLiveBypass Safe; ele foi preservado.");
}

function removeQuarantinedLoader(
  trashPath: string,
  record: Pick<InstallationRecord, "id" | "resourcesPath">,
): void {
  if (existingStat(trashPath) === undefined) return;
  if (!ownsLoader(trashPath, record)) {
    throw new Error("O carregador isolado mudou e foi preservado.");
  }
  safeRemove(trashPath, true);
}

function authenticatesLoader(
  livePath: string,
  record: Pick<InstallationRecord, "id" | "resourcesPath" | "originalSha256">,
  runtimePayloadPath: string,
): boolean {
  const owner = loaderIdentity(livePath);
  if (
    owner === null ||
    owner.id !== record.id ||
    !samePath(owner.resourcesPath, record.resourcesPath) ||
    owner.originalSha256 !== record.originalSha256
  ) {
    return false;
  }
  const entries = fs.readdirSync(livePath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  const expectedNames = [OWNER_FILE, "index.js", "package.json"].sort();
  if (
    entries.length !== expectedNames.length ||
    entries.some((entry, index) => entry.name !== expectedNames[index] || !entry.isFile())
  ) {
    return false;
  }
  const indexContent = `require(${JSON.stringify(runtimePayloadPath)});\n`;
  const ownerContent = jsonText(expectedOwner(record, runtimePayloadPath));
  return (
    fs.readFileSync(path.join(livePath, "package.json"), "utf8") === PACKAGE_CONTENT &&
    fs.readFileSync(path.join(livePath, "index.js"), "utf8") === indexContent &&
    fs.readFileSync(path.join(livePath, OWNER_FILE), "utf8") === ownerContent
  );
}

function selfAuthenticatesLoader(livePath: string, identity: LoaderIdentity): boolean {
  if (
    identity.runtimePayloadPath === undefined ||
    identity.loaderSha256 === undefined ||
    !path.isAbsolute(identity.runtimePayloadPath) ||
    identity.runtimePayloadPath.includes("\0") ||
    path.resolve(identity.runtimePayloadPath) !== identity.runtimePayloadPath ||
    identity.loaderSha256 !== loaderHash(identity, identity.runtimePayloadPath)
  ) {
    return false;
  }
  return authenticatesLoader(livePath, identity, identity.runtimePayloadPath);
}

function createLoader(stagePath: string, transaction: InstallTransaction, runtimePayloadPath: string): void {
  assertNoReparse(stagePath);
  fs.mkdirSync(stagePath);
  assertNoReparse(stagePath);
  writeFileDurably(path.join(stagePath, "package.json"), PACKAGE_CONTENT);
  writeFileDurably(path.join(stagePath, "index.js"), `require(${JSON.stringify(runtimePayloadPath)});\n`);
  writeFileDurably(path.join(stagePath, OWNER_FILE), jsonText(expectedOwner(transaction, runtimePayloadPath)));
  if (!authenticatesLoader(stagePath, transaction, runtimePayloadPath)) {
    throw new Error("O carregador preparado nao confere.");
  }
}

function localOriginalPath(resourcesPath: string): string | null {
  const originalPath = path.join(resourcesPath, ORIGINAL_NAME);
  const legacyOriginalPath = path.join(resourcesPath, LEGACY_ORIGINAL_NAME);
  const originalExists = existingStat(originalPath) !== undefined;
  const legacyExists = existingStat(legacyOriginalPath) !== undefined;
  if (originalExists && legacyExists) throw new Error("Foram encontrados dois originais locais; nada foi alterado.");
  if (originalExists) return originalPath;
  if (legacyExists) return legacyOriginalPath;
  return null;
}

function isValidOriginal(file: string, expectedSha256: string): boolean {
  const stat = existingStat(file);
  return stat !== undefined && stat.isFile() && stat.nlink === 1 && hashFile(file) === expectedSha256;
}

function pendingBackupPath(record: InstallationRecord): string {
  return `${record.backupPath}.pending`;
}

function promotePendingBackup(record: InstallationRecord): boolean {
  if (existingStat(record.backupPath) !== undefined) return false;
  const pendingPath = pendingBackupPath(record);
  if (existingStat(pendingPath) === undefined) return false;
  assertSingleLinkFile(pendingPath);
  if (!isValidOriginal(pendingPath, record.originalSha256)) {
    safeRemove(pendingPath);
    return false;
  }
  safeRename(pendingPath, record.backupPath);
  flushFile(record.backupPath);
  assertSingleLinkFile(record.backupPath);
  return isValidOriginal(record.backupPath, record.originalSha256);
}

function assertIndependentOriginals(record: InstallationRecord, localOriginal: string): void {
  assertSingleLinkFile(localOriginal);
  assertSingleLinkFile(record.backupPath);
  if (sameFileIdentity(localOriginal, record.backupPath)) {
    throw new Error(`${record.flavour}: os backups local e externo apontam para o mesmo arquivo.`);
  }
}

function ensureExternalBackup(record: InstallationRecord, source: string): void {
  promotePendingBackup(record);
  const backupStat = existingStat(record.backupPath);
  if (backupStat !== undefined) {
    assertSingleLinkFile(record.backupPath);
    if (!isValidOriginal(record.backupPath, record.originalSha256)) {
      throw new Error(`${record.flavour}: o backup externo existente nao confere.`);
    }
    if (isValidOriginal(source, record.originalSha256)) assertIndependentOriginals(record, source);
    safeRemove(pendingBackupPath(record));
    return;
  }
  if (!isValidOriginal(source, record.originalSha256)) throw new Error(`${record.flavour}: original local invalido.`);
  const pendingPath = pendingBackupPath(record);
  safeRemove(pendingPath);
  try {
    safeCopy(source, pendingPath);
    if (!isValidOriginal(pendingPath, record.originalSha256)) {
      throw new Error(`${record.flavour}: a copia de seguranca preparada nao confere.`);
    }
    safeRename(pendingPath, record.backupPath);
    flushFile(record.backupPath);
    assertSingleLinkFile(record.backupPath);
    if (!isValidOriginal(record.backupPath, record.originalSha256)) {
      throw new Error(`${record.flavour}: a copia de seguranca nao confere.`);
    }
    assertIndependentOriginals(record, source);
  } finally {
    safeRemove(pendingPath);
  }
}

function assertOriginalCopies(record: InstallationRecord, localOriginal: string): void {
  if (
    !isValidOriginal(localOriginal, record.originalSha256) ||
    !isValidOriginal(record.backupPath, record.originalSha256)
  ) {
    throw new Error(`${record.flavour}: os backups mudaram antes da confirmacao da transacao.`);
  }
  assertIndependentOriginals(record, localOriginal);
}

function prepareOriginalSource(record: InstallationRecord, stagePath: string): string {
  promotePendingBackup(record);
  const localOriginal = localOriginalPath(record.resourcesPath);
  if (localOriginal !== null && isValidOriginal(localOriginal, record.originalSha256)) return localOriginal;
  if (isValidOriginal(stagePath, record.originalSha256)) return stagePath;
  if (!isValidOriginal(record.backupPath, record.originalSha256)) {
    throw new Error(`${record.flavour}: os dois backups do Discord estao ausentes ou invalidos.`);
  }
  safeRemove(stagePath, true);
  safeCopy(record.backupPath, stagePath);
  if (!isValidOriginal(stagePath, record.originalSha256)) {
    throw new Error(`${record.flavour}: o backup preparado nao confere.`);
  }
  return stagePath;
}

function removeLocalOriginals(resourcesPath: string): void {
  safeRemove(path.join(resourcesPath, ORIGINAL_NAME), true);
  safeRemove(path.join(resourcesPath, LEGACY_ORIGINAL_NAME), true);
}

function ensureLocalOriginal(record: InstallationRecord, stagePath: string): string {
  const corrected = path.join(record.resourcesPath, ORIGINAL_NAME);
  const legacy = path.join(record.resourcesPath, LEGACY_ORIGINAL_NAME);
  const localOriginal = localOriginalPath(record.resourcesPath);
  if (localOriginal !== null && isValidOriginal(localOriginal, record.originalSha256)) {
    if (samePath(localOriginal, legacy)) {
      safeRename(legacy, corrected);
      if (!isValidOriginal(corrected, record.originalSha256)) {
        throw new Error(`${record.flavour}: o backup local migrado nao confere.`);
      }
    }
    return corrected;
  }

  const source = prepareOriginalSource(record, stagePath);
  removeLocalOriginals(record.resourcesPath);
  safeRename(source, corrected);
  if (!isValidOriginal(corrected, record.originalSha256)) {
    throw new Error(`${record.flavour}: o backup local recuperado nao confere.`);
  }
  return corrected;
}

function finalizeRestoredFile(record: InstallationRecord, livePath: string): void {
  if (!isValidOriginal(livePath, record.originalSha256)) {
    throw new Error("O Discord restaurado nao confere com o original.");
  }
  assertNoReparse(livePath);
  fs.chmodSync(livePath, record.originalMode);
  const modified = new Date(record.originalMtimeMs);
  assertNoReparse(livePath);
  fs.utimesSync(livePath, modified, modified);
  assertSingleLinkFile(livePath);
  if (!isValidOriginal(livePath, record.originalSha256)) {
    throw new Error("O Discord restaurado mudou durante a finalizacao.");
  }
}

function writeInstallationRecord(transaction: InstallTransaction): void {
  writeJson(transaction.recordPath, transaction);
}

function rollbackInstall(transaction: InstallTransaction, dataRoot: string, journalPath: string): void {
  assertTransactionTopology(transaction, dataRoot);
  const rollbackTrashPath = rollbackLoaderTrashPath(transaction.resourcesPath);
  let liveIsOriginal = isValidOriginal(transaction.livePath, transaction.originalSha256);
  if (!liveIsOriginal) {
    const source = prepareOriginalSource(transaction, transaction.stagePath);
    const liveStat = existingStat(transaction.livePath);
    if (liveStat !== undefined) {
      quarantineOwnedLoader(transaction.livePath, rollbackTrashPath, transaction);
    }
    safeRename(source, transaction.livePath);
    liveIsOriginal = isValidOriginal(transaction.livePath, transaction.originalSha256);
  }
  if (!liveIsOriginal) throw new Error(`${transaction.flavour}: o original nao pode ser recuperado.`);

  finalizeRestoredFile(transaction, transaction.livePath);
  removeQuarantinedLoader(rollbackTrashPath, transaction);
  removeQuarantinedLoader(repairLoaderTrashPath(transaction.resourcesPath), transaction);
  removeLocalOriginals(transaction.resourcesPath);
  safeRemove(transaction.stagePath, true);
  safeRemove(transaction.backupPath);
  safeRemove(transaction.recordPath);
  safeRemove(journalPath);
}

function compareVersions(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

export function discoverAllDiscordTargets(localAppData: string): DiscordTarget[] {
  return withNoAsar(() => {
    assertCanonicalPath(localAppData);
    assertNoReparse(localAppData);
    const targets: DiscordTarget[] = [];
    for (const flavour of DISCORD_FLAVOURS) {
      const root = path.join(localAppData, flavour);
      const rootStat = existingStat(root);
      if (rootStat === undefined) continue;
      if (!rootStat.isDirectory()) throw new Error(`${flavour}: raiz do Discord invalida.`);
      const versions = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => {
          if (entry.name.startsWith("app-") && entry.isSymbolicLink()) {
            throw new Error(`${flavour}: versao do Discord usa link ou ponto de nova analise.`);
          }
          return entry.isDirectory() && entry.name.startsWith("app-") && VERSION_PATTERN.test(entry.name.slice(4));
        })
        .map((entry) => entry.name.slice(4))
        .sort(compareVersions);
      for (const version of versions) {
        const appPath = path.join(root, `app-${version}`);
        const resourcesPath = path.join(appPath, "resources");
        const executablePath = path.join(appPath, `${flavour}.exe`);
        assertNoReparse(appPath);
        assertNoReparse(resourcesPath);
        assertNoReparse(executablePath);
        const resourcesStat = existingStat(resourcesPath);
        const executableStat = existingStat(executablePath);
        if (resourcesStat?.isDirectory() && executableStat?.isFile()) {
          targets.push({ flavour, version, resourcesPath, executablePath });
        }
      }
    }
    return targets;
  });
}

export function discoverDiscordTargets(localAppData: string): DiscordTarget[] {
  const targets = discoverAllDiscordTargets(localAppData);
  return DISCORD_FLAVOURS.flatMap((flavour) => targets.filter((target) => target.flavour === flavour).slice(-1));
}

export function inspectTarget(target: DiscordTarget): TargetStatus {
  return withNoAsar(() => {
    const validated = validateTarget(target);
    assertTargetTopology(validated);
    const livePath = path.join(validated.resourcesPath, "app.asar");
    const originalPath = path.join(validated.resourcesPath, ORIGINAL_NAME);
    const legacyOriginalPath = path.join(validated.resourcesPath, LEGACY_ORIGINAL_NAME);
    const foreignOriginal = path.join(validated.resourcesPath, FOREIGN_ORIGINAL_NAME);
    const id = recordId(validated.resourcesPath);
    const originalExists = existingStat(originalPath) !== undefined;
    const legacyExists = existingStat(legacyOriginalPath) !== undefined;

    if (existingStat(foreignOriginal) !== undefined) {
      return { ...validated, state: "foreign", detail: "Outro modificador ja usa _app.asar." };
    }
    const identity = loaderIdentity(livePath);
    if (identity !== null && identity.id === id && samePath(identity.resourcesPath, validated.resourcesPath)) {
      if (originalExists !== legacyExists) {
        if (!selfAuthenticatesLoader(livePath, identity)) {
          return { ...validated, state: "installed", detail: "Carregador proprio modificado; Reparar o reconstruira." };
        }
        const detail = legacyExists
          ? "Bypass v0.1.0 detectado; Instalar ou Reparar migrara o backup local."
          : "Bypass instalado com backup local e externo.";
        return { ...validated, state: "installed", detail };
      }
      return { ...validated, state: "broken", detail: "O backup local esta ausente ou duplicado; use Restaurar original." };
    }

    const liveStat = existingStat(livePath);
    if (liveStat?.isDirectory() && existingStat(path.join(livePath, OWNER_FILE)) !== undefined) {
      return { ...validated, state: "broken", detail: "Carregador proprio danificado; use Restaurar original." };
    }
    if (originalExists || legacyExists || liveStat === undefined) {
      return { ...validated, state: "broken", detail: "Instalacao interrompida; use Reparar." };
    }
    if (liveStat.isDirectory()) {
      return { ...validated, state: "foreign", detail: "app.asar ja e um carregador de terceiros." };
    }
    if (!liveStat.isFile()) {
      return { ...validated, state: "foreign", detail: "app.asar nao e um arquivo regular." };
    }
    return { ...validated, state: "vanilla", detail: "Discord original, pronto para instalar." };
  });
}

function validateRuntimePayload(dataRoot: string, runtimePayloadPath: string): void {
  const expected = path.join(dataRoot, "runtime", "payload.cjs");
  if (!samePath(runtimePayloadPath, expected)) throw new Error("O payload nao pertence ao runtime local esperado.");
  const stat = existingStat(runtimePayloadPath);
  if (stat === undefined || !stat.isFile()) throw new Error("O payload local verificado nao foi encontrado.");
}

function installTransactionFor(
  target: DiscordTarget,
  dataRoot: string,
  source: string,
  installedAt = new Date().toISOString(),
): InstallTransaction {
  const id = recordId(target.resourcesPath);
  const paths = recordPaths(dataRoot, id);
  const sourceStat = fs.lstatSync(source);
  return {
    schema: SCHEMA,
    operation: "install",
    id,
    ...target,
    originalSha256: hashFile(source),
    originalMode: sourceStat.mode,
    originalMtimeMs: sourceStat.mtimeMs,
    backupPath: paths.backupPath,
    installedAt,
    livePath: path.join(target.resourcesPath, "app.asar"),
    originalPath: path.join(target.resourcesPath, ORIGINAL_NAME),
    stagePath: path.join(target.resourcesPath, `.golive-staging-${randomUUID()}`),
    recordPath: paths.recordPath,
  };
}

function repairTransactionFor(record: InstallationRecord, dataRoot: string): InstallTransaction {
  return {
    ...record,
    operation: "install",
    livePath: path.join(record.resourcesPath, "app.asar"),
    originalPath: path.join(record.resourcesPath, ORIGINAL_NAME),
    stagePath: path.join(record.resourcesPath, `.golive-staging-${randomUUID()}`),
    recordPath: recordPaths(dataRoot, record.id).recordPath,
  };
}

function runInstallTransaction(
  transaction: InstallTransaction,
  dataRoot: string,
  runtimePayloadPath: string,
  repair: boolean,
): void {
  const journalPath = recordPaths(dataRoot, transaction.id).journalPath;
  assertTransactionTopology(transaction, dataRoot);
  createJournal(journalPath, { phase: "planned", transaction });
  try {
    let localOriginal: string;
    if (repair) {
      localOriginal = ensureLocalOriginal(transaction, transaction.stagePath);
      ensureExternalBackup(transaction, localOriginal);
    } else {
      localOriginal = transaction.livePath;
      ensureExternalBackup(transaction, transaction.livePath);
    }
    appendJournal(journalPath, { phase: "backed_up" });

    safeRemove(transaction.stagePath, true);
    createLoader(transaction.stagePath, transaction, runtimePayloadPath);
    appendJournal(journalPath, { phase: "staged" });
    assertOriginalCopies(transaction, localOriginal);

    if (repair) {
      quarantineOwnedLoader(
        transaction.livePath,
        repairLoaderTrashPath(transaction.resourcesPath),
        transaction,
      );
    } else {
      safeRename(transaction.livePath, transaction.originalPath);
      if (
        !isValidOriginal(transaction.originalPath, transaction.originalSha256) ||
        !isValidOriginal(transaction.backupPath, transaction.originalSha256)
      ) {
        throw new Error(`${transaction.flavour}: o original movido nao confere.`);
      }
    }
    appendJournal(journalPath, { phase: "original_moved" });

    safeRename(transaction.stagePath, transaction.livePath);
    if (!authenticatesLoader(transaction.livePath, transaction, runtimePayloadPath)) {
      throw new Error(`${transaction.flavour}: o carregador instalado nao confere.`);
    }
    writeInstallationRecord(transaction);
    appendJournal(journalPath, { phase: "committed" });
    removeQuarantinedLoader(repairLoaderTrashPath(transaction.resourcesPath), transaction);
    safeRemove(journalPath);
  } catch (error) {
    try {
      rollbackInstall(transaction, dataRoot, journalPath);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `${transaction.flavour}: falha preservada para recuperacao.`);
    }
    throw error;
  }
}

export function installTarget(target: DiscordTarget, dataRoot: string, runtimePayloadPath: string): InstallationRecord {
  return withNoAsar(() => {
    assertDataRootTopology(dataRoot);
    const validated = validateTarget(target, dataRoot);
    assertTargetTopology(validated);
    validateRuntimePayload(dataRoot, runtimePayloadPath);
    const status = inspectTarget(validated);
    const id = recordId(validated.resourcesPath);
    const paths = recordPaths(dataRoot, id);
    if (status.state === "foreign") throw new Error(`${validated.flavour}: recusado para preservar o outro modificador.`);
    if (status.state === "broken") throw new Error(`${validated.flavour}: execute a recuperacao antes de instalar.`);

    if (status.state === "installed") {
      if (existingStat(paths.recordPath) === undefined) throw new Error(`${validated.flavour}: registro de instalacao ausente.`);
      const record = readRecordFile(dataRoot, `${id}.json`);
      if (
        record.flavour !== validated.flavour ||
        record.version !== validated.version ||
        !samePath(record.resourcesPath, validated.resourcesPath) ||
        !samePath(record.executablePath, validated.executablePath)
      ) {
        throw new Error(`${validated.flavour}: registro nao corresponde ao alvo atual.`);
      }
      const localOriginal = localOriginalPath(validated.resourcesPath);
      const localReady =
        localOriginal !== null &&
        samePath(localOriginal, path.join(validated.resourcesPath, ORIGINAL_NAME)) &&
        isValidOriginal(localOriginal, record.originalSha256);
      const externalReady = isValidOriginal(record.backupPath, record.originalSha256);
      if (localReady && externalReady) {
        assertIndependentOriginals(record, localOriginal);
        if (authenticatesLoader(path.join(validated.resourcesPath, "app.asar"), record, runtimePayloadPath)) {
          return record;
        }
      }

      const transaction = repairTransactionFor(record, dataRoot);
      runInstallTransaction(transaction, dataRoot, runtimePayloadPath, true);
      return transaction;
    }

    const livePath = path.join(validated.resourcesPath, "app.asar");
    const liveStat = existingStat(livePath);
    if (liveStat === undefined || !liveStat.isFile()) throw new Error(`${validated.flavour}: app.asar original invalido.`);
    const transaction = installTransactionFor(validated, dataRoot, livePath);
    runInstallTransaction(transaction, dataRoot, runtimePayloadPath, false);
    return transaction;
  });
}

function advanceUninstallJournal(
  journalPath: string,
  currentPhase: string,
  targetPhase: (typeof UNINSTALL_PHASES)[number],
): string {
  let currentIndex = UNINSTALL_PHASES.indexOf(currentPhase as (typeof UNINSTALL_PHASES)[number]);
  const targetIndex = UNINSTALL_PHASES.indexOf(targetPhase);
  while (currentIndex < targetIndex) {
    currentIndex += 1;
    appendJournal(journalPath, { phase: UNINSTALL_PHASES[currentIndex]! });
  }
  return UNINSTALL_PHASES[currentIndex]!;
}

function completeUninstall(
  transaction: UninstallTransaction,
  dataRoot: string,
  journalPath: string,
  startingPhase: string,
): void {
  assertTransactionTopology(transaction, dataRoot);
  let phase = startingPhase;
  let liveIsOriginal = isValidOriginal(transaction.livePath, transaction.originalSha256);
  if (!liveIsOriginal) {
    const source = prepareOriginalSource(transaction, transaction.restoreStagePath);
    phase = advanceUninstallJournal(journalPath, phase, "restore_prepared");
    const liveStat = existingStat(transaction.livePath);
    if (liveStat !== undefined) {
      if (existingStat(transaction.loaderTrashPath) !== undefined) {
        throw new Error(`${transaction.flavour}: ha dois carregadores durante a recuperacao.`);
      }
      safeRename(transaction.livePath, transaction.loaderTrashPath);
      if (!ownsLoader(transaction.loaderTrashPath, transaction)) {
        if (existingStat(transaction.livePath) === undefined) {
          safeRename(transaction.loaderTrashPath, transaction.livePath);
        }
        throw new Error(`${transaction.flavour}: app.asar mudou desde a instalacao; nada foi removido.`);
      }
    }
    phase = advanceUninstallJournal(journalPath, phase, "loader_moved");
    if (existingStat(transaction.livePath) === undefined) safeRename(source, transaction.livePath);
    liveIsOriginal = isValidOriginal(transaction.livePath, transaction.originalSha256);
    if (!liveIsOriginal) throw new Error(`${transaction.flavour}: o arquivo promovido nao confere.`);
  }
  advanceUninstallJournal(journalPath, phase, "restored");
  finalizeRestoredFile(transaction, transaction.livePath);
  removeQuarantinedLoader(transaction.loaderTrashPath, transaction);
  safeRemove(transaction.restoreStagePath, true);
  removeLocalOriginals(transaction.resourcesPath);
  safeRemove(transaction.backupPath);
  safeRemove(transaction.recordPath);
  safeRemove(journalPath);
}

export function uninstallAll(dataRoot: string, requiredRestoredTargets: DiscordTarget[]): string[] {
  return withNoAsar(() => {
    assertDataRootTopology(dataRoot);
    const records = readRecords(dataRoot);
    for (const target of requiredRestoredTargets) {
      assertTargetTopology(validateTarget(target, dataRoot));
    }

    const restored: string[] = [];
    for (const record of records) {
      if (existingStat(record.resourcesPath) === undefined) continue;
      const paths = recordPaths(dataRoot, record.id);
      const transaction: UninstallTransaction = {
        ...record,
        operation: "uninstall",
        livePath: path.join(record.resourcesPath, "app.asar"),
        originalPath: localOriginalPath(record.resourcesPath) ?? path.join(record.resourcesPath, ORIGINAL_NAME),
        restoreStagePath: path.join(record.resourcesPath, `.golive-restore-${randomUUID()}`),
        loaderTrashPath: path.join(record.resourcesPath, `.golive-loader-${randomUUID()}`),
        recordPath: paths.recordPath,
      };
      assertTransactionTopology(transaction, dataRoot);
      createJournal(paths.journalPath, { phase: "planned", transaction });
      completeUninstall(transaction, dataRoot, paths.journalPath, "planned");
      restored.push(record.flavour);
    }

    const unresolved = requiredRestoredTargets.filter((target) => {
      const state = inspectTarget(target).state;
      if (state === "installed" || state === "broken") return true;
      const backupPath = recordPaths(dataRoot, recordId(target.resourcesPath)).backupPath;
      return state === "foreign" && existingStat(backupPath) !== undefined;
    });
    if (unresolved.length !== 0) {
      throw new Error(`O Discord continua modificado em: ${unresolved.map((target) => target.flavour).join(", ")}.`);
    }
    return restored;
  });
}

function recoverInstall(transaction: InstallTransaction, dataRoot: string, journalPath: string): void {
  const runtimePayloadPath = path.join(dataRoot, "runtime", "payload.cjs");
  if (authenticatesLoader(transaction.livePath, transaction, runtimePayloadPath)) {
    const localOriginal = ensureLocalOriginal(transaction, transaction.stagePath);
    ensureExternalBackup(transaction, localOriginal);
    if (!authenticatesLoader(transaction.livePath, transaction, runtimePayloadPath)) {
      throw new Error(`${transaction.flavour}: o carregador mudou durante a recuperacao.`);
    }
    writeInstallationRecord(transaction);
    safeRemove(transaction.stagePath, true);
    removeQuarantinedLoader(repairLoaderTrashPath(transaction.resourcesPath), transaction);
    safeRemove(journalPath);
    return;
  }
  rollbackInstall(transaction, dataRoot, journalPath);
}

export function recoverTransactions(dataRoot: string): string[] {
  return withNoAsar(() => {
    assertDataRootTopology(dataRoot);
    const directory = path.join(dataRoot, "transactions");
    const directoryStat = existingStat(directory);
    if (directoryStat === undefined) return [];
    if (!directoryStat.isDirectory()) throw new Error("Diretorio de transacoes invalido.");

    const journals = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.name.endsWith(".jsonl"))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => {
        if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`Journal de transacao invalido: ${entry.name}.`);
        const journalPath = path.join(directory, entry.name);
        return { journalPath, ...readJournal(journalPath, dataRoot, entry.name) };
      });

    const recovered: string[] = [];
    for (const { journalPath, transaction, phase } of journals) {
      if (transaction.operation === "install") {
        recoverInstall(transaction, dataRoot, journalPath);
      } else {
        completeUninstall(transaction, dataRoot, journalPath, phase);
      }
      recovered.push(transaction.flavour);
    }
    return recovered;
  });
}

export function installedRecords(dataRoot: string): InstallationRecord[] {
  return withNoAsar(() => readRecords(dataRoot));
}
