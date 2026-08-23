import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

interface TorManifest {
  schema: number;
  version: string;
  source: string;
  archiveSha256: string;
  files: Record<string, string>;
}

interface RuntimeLayout {
  payloadPath: string;
  pacPath: string;
  safetyPath: string;
  manifestPath: string;
  torRoot: string;
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function locateRuntime(sourceRoot: string): RuntimeLayout {
  const unified = fs.existsSync(path.join(sourceRoot, "payload.cjs"));
  return unified
    ? {
        payloadPath: path.join(sourceRoot, "payload.cjs"),
        pacPath: path.join(sourceRoot, "proxy.pac"),
        safetyPath: path.join(sourceRoot, "runtime-safety.cjs"),
        manifestPath: path.join(sourceRoot, "tor-manifest.json"),
        torRoot: path.join(sourceRoot, "tor"),
      }
    : {
        payloadPath: path.join(sourceRoot, "runtime", "payload.cjs"),
        pacPath: path.join(sourceRoot, "runtime", "proxy.pac"),
        safetyPath: path.join(sourceRoot, "runtime", "runtime-safety.cjs"),
        manifestPath: path.join(sourceRoot, "vendor", "tor-manifest.json"),
        torRoot: path.join(sourceRoot, "vendor", "tor"),
      };
}

function readManifest(manifestPath: string): TorManifest {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Partial<TorManifest>;
  if (
    manifest.schema !== 1 ||
    typeof manifest.version !== "string" ||
    typeof manifest.source !== "string" ||
    typeof manifest.archiveSha256 !== "string" ||
    manifest.files === null ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files) ||
    typeof manifest.files["tor/tor.exe"] !== "string"
  ) {
    throw new Error("Manifesto do Tor invalido.");
  }
  return manifest as TorManifest;
}

function manifestFile(root: string, name: string): string {
  if (typeof name !== "string" || name.length === 0 || name.includes("\0")) {
    throw new Error("Caminho invalido no manifesto do Tor.");
  }
  const portableName = name.replaceAll("\\", "/");
  const segments = portableName.split("/");
  if (
    portableName.startsWith("/") ||
    /^[a-z]:/i.test(portableName) ||
    segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes(":"))
  ) {
    throw new Error("Caminho invalido no manifesto do Tor.");
  }
  const resolvedRoot = path.resolve(root);
  if (fs.lstatSync(resolvedRoot).isSymbolicLink()) throw new Error("A raiz do runtime do Tor nao pode ser um link.");
  const file = path.resolve(resolvedRoot, ...segments);
  const physicalRoot = fs.realpathSync.native(resolvedRoot);
  const physicalFile = fs.realpathSync.native(file);
  const relative = path.relative(physicalRoot, physicalFile);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Caminho do manifesto saiu do runtime do Tor.");
  }
  return physicalFile;
}

function filesBelow(root: string, current = root): string[] {
  if (fs.lstatSync(path.resolve(root)).isSymbolicLink()) throw new Error("A raiz do runtime do Tor nao pode ser um link.");
  return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) throw new Error("Links nao sao permitidos no runtime do Tor.");
    const file = path.join(current, entry.name);
    const name = path.relative(root, file).replaceAll("\\", "/");
    manifestFile(root, name);
    if (entry.isDirectory()) return filesBelow(root, file);
    if (entry.isFile()) return [name];
    throw new Error("Entrada nao suportada no runtime do Tor.");
  });
}

function verifyRuntime(sourceRoot: string): { layout: RuntimeLayout; manifest: TorManifest } {
  const layout = locateRuntime(sourceRoot);
  for (const required of [layout.payloadPath, layout.pacPath, layout.safetyPath, layout.manifestPath]) {
    if (!fs.existsSync(required) || !fs.statSync(required).isFile()) {
      throw new Error(`Runtime incompleto: ${path.basename(required)}.`);
    }
  }
  const manifest = readManifest(layout.manifestPath);
  const listedFiles = Object.keys(manifest.files).sort();
  const actualFiles = filesBelow(layout.torRoot).sort();
  if (listedFiles.length !== actualFiles.length || listedFiles.some((name, index) => name !== actualFiles[index])) {
    throw new Error("Os arquivos do runtime do Tor nao conferem com o manifesto.");
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = manifestFile(layout.torRoot, name);
    if (
      !/^[a-f0-9]{64}$/i.test(expected) ||
      !fs.existsSync(file) ||
      !fs.statSync(file).isFile() ||
      sha256(file) !== expected.toLowerCase()
    ) {
      throw new Error(`Arquivo do Tor invalido: ${name}.`);
    }
  }
  return { layout, manifest };
}

function runtimeIdentity(sourceRoot: string): string {
  const { layout, manifest } = verifyRuntime(sourceRoot);
  return createHash("sha256")
    .update(sha256(layout.payloadPath))
    .update(sha256(layout.pacPath))
    .update(sha256(layout.safetyPath))
    .update(JSON.stringify(manifest))
    .digest("hex");
}

export function prepareRuntime(sourceRoot: string, dataRoot: string): string {
  if (!fs.existsSync(sourceRoot)) throw new Error("O executavel nao inclui o runtime local.");
  const sourceIdentity = runtimeIdentity(sourceRoot);
  const destination = path.join(dataRoot, "runtime");
  if (fs.existsSync(destination)) {
    try {
      if (runtimeIdentity(destination) === sourceIdentity) return path.join(destination, "payload.cjs");
    } catch {
      // A staged replacement below repairs a partial or modified runtime.
    }
  }

  fs.mkdirSync(dataRoot, { recursive: true });
  const stage = path.join(dataRoot, `.runtime-stage-${randomUUID()}`);
  const previous = path.join(dataRoot, `.runtime-previous-${randomUUID()}`);
  try {
    const { layout } = verifyRuntime(sourceRoot);
    fs.mkdirSync(stage);
    fs.copyFileSync(layout.payloadPath, path.join(stage, "payload.cjs"), fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(layout.pacPath, path.join(stage, "proxy.pac"), fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(layout.safetyPath, path.join(stage, "runtime-safety.cjs"), fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(layout.manifestPath, path.join(stage, "tor-manifest.json"), fs.constants.COPYFILE_EXCL);
    fs.cpSync(layout.torRoot, path.join(stage, "tor"), { recursive: true, errorOnExist: true, force: false });
    if (runtimeIdentity(stage) !== sourceIdentity) throw new Error("A copia local do runtime nao confere.");
    if (fs.existsSync(destination)) fs.renameSync(destination, previous);
    fs.renameSync(stage, destination);
    fs.rmSync(previous, { recursive: true, force: true });
    return path.join(destination, "payload.cjs");
  } catch (error) {
    if (!fs.existsSync(destination) && fs.existsSync(previous)) fs.renameSync(previous, destination);
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

export function runtimeSourceReady(sourceRoot: string): boolean {
  try {
    verifyRuntime(sourceRoot);
    return true;
  } catch {
    return false;
  }
}
