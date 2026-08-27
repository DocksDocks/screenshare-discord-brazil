import { createHash } from "node:crypto";
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
  relayPath: string;
  safetyPath: string;
  manifestPath: string;
  torRoot: string;
}

const PACKAGED_RUNTIME_SHA256 = {
  "gateway-relay.cjs": "8519c0a763e9d88b79fd073fdcaf77d931e75af5bb26ac6aa530fff8c2574d3e",
  "payload.cjs": "3531f6924da4698d9f6827d19d31117158b7c36b2eb1377785f07819ebd7cfc1",
  "proxy.pac": "ef392cc5619a91e4ff412b2ab0fdca5252dc8a78c899876986d71828b44fc50f",
  "runtime-safety.cjs": "8071de16675ff07848cb1f24380b8297d058f87a6e9b05ea23238bf941018186",
  "tor-manifest.json": "498db398b840eb241cbcad35fcb2960f5b229a9a6687f4cc3dacaf9f09567343",
} as const;

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sourceSha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n")).digest("hex");
}

function locateRuntime(sourceRoot: string): RuntimeLayout {
  const unified = fs.existsSync(path.join(sourceRoot, "payload.cjs"));
  return unified
    ? {
        payloadPath: path.join(sourceRoot, "payload.cjs"),
        pacPath: path.join(sourceRoot, "proxy.pac"),
        relayPath: path.join(sourceRoot, "gateway-relay.cjs"),
        safetyPath: path.join(sourceRoot, "runtime-safety.cjs"),
        manifestPath: path.join(sourceRoot, "tor-manifest.json"),
        torRoot: path.join(sourceRoot, "tor"),
      }
    : {
        payloadPath: path.join(sourceRoot, "runtime", "payload.cjs"),
        pacPath: path.join(sourceRoot, "runtime", "proxy.pac"),
        relayPath: path.join(sourceRoot, "runtime", "gateway-relay.cjs"),
        safetyPath: path.join(sourceRoot, "runtime", "runtime-safety.cjs"),
        manifestPath: path.join(sourceRoot, "vendor", "tor-manifest.json"),
        torRoot: path.join(sourceRoot, "vendor", "tor"),
      };
}

function isPackagedRuntimeSource(sourceRoot: string): boolean {
  const resourcesPath = (process as typeof process & { resourcesPath?: string }).resourcesPath;
  return typeof resourcesPath === "string" && path.resolve(sourceRoot) === path.resolve(resourcesPath, "runtime");
}

function verifyPackagedRuntime(layout: RuntimeLayout): void {
  const files: Record<string, string> = {
    "gateway-relay.cjs": layout.relayPath,
    "payload.cjs": layout.payloadPath,
    "proxy.pac": layout.pacPath,
    "runtime-safety.cjs": layout.safetyPath,
    "tor-manifest.json": layout.manifestPath,
  };
  for (const [name, expected] of Object.entries(PACKAGED_RUNTIME_SHA256)) {
    if (sourceSha256(files[name]) !== expected) throw new Error(`Runtime empacotado invalido: ${name}.`);
  }
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

function verifyRuntime(sourceRoot: string, enforcePackagedHashes: boolean): { layout: RuntimeLayout; manifest: TorManifest } {
  const layout = locateRuntime(sourceRoot);
  for (const required of [layout.payloadPath, layout.pacPath, layout.relayPath, layout.safetyPath, layout.manifestPath]) {
    if (!fs.existsSync(required) || !fs.statSync(required).isFile()) {
      throw new Error(`Runtime incompleto: ${path.basename(required)}.`);
    }
  }
  if (enforcePackagedHashes) verifyPackagedRuntime(layout);
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

function runtimeIdentity(sourceRoot: string, enforcePackagedHashes: boolean): string {
  const { layout } = verifyRuntime(sourceRoot, enforcePackagedHashes);
  return createHash("sha256")
    .update(sha256(layout.payloadPath))
    .update(sha256(layout.pacPath))
    .update(sha256(layout.relayPath))
    .update(sha256(layout.safetyPath))
    .update(sha256(layout.manifestPath))
    .digest("hex");
}

export function prepareRuntime(sourceRoot: string, dataRoot: string): string {
  if (!fs.existsSync(sourceRoot)) throw new Error("O executavel nao inclui o runtime local.");
  const enforcePackagedHashes = isPackagedRuntimeSource(sourceRoot);
  const sourceIdentity = runtimeIdentity(sourceRoot, enforcePackagedHashes);
  const destination = path.join(dataRoot, "runtime");
  const stage = path.join(dataRoot, ".runtime-stage");
  const previous = path.join(dataRoot, ".runtime-previous");
  const matchesSource = (root: string): boolean => {
    try {
      return runtimeIdentity(root, enforcePackagedHashes) === sourceIdentity;
    } catch {
      return false;
    }
  };
  const isCompleteRuntime = (root: string): boolean => {
    try {
      runtimeIdentity(root, false);
      return true;
    } catch {
      return false;
    }
  };

  fs.mkdirSync(dataRoot, { recursive: true });
  if (fs.existsSync(destination) && matchesSource(destination)) {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(previous, { recursive: true, force: true });
    return path.join(destination, "payload.cjs");
  }

  if (fs.existsSync(previous)) {
    if (!fs.existsSync(destination) && fs.existsSync(stage) && matchesSource(stage)) {
      fs.renameSync(stage, destination);
      fs.rmSync(previous, { recursive: true, force: true });
      return path.join(destination, "payload.cjs");
    }
    if (fs.existsSync(destination) && isCompleteRuntime(destination)) {
      fs.rmSync(previous, { recursive: true, force: true });
    } else {
      fs.rmSync(destination, { recursive: true, force: true });
      fs.renameSync(previous, destination);
    }
  }
  fs.rmSync(stage, { recursive: true, force: true });
  if (fs.existsSync(destination)) {
    if (matchesSource(destination)) return path.join(destination, "payload.cjs");
  }

  try {
    const { layout } = verifyRuntime(sourceRoot, enforcePackagedHashes);
    fs.mkdirSync(stage);
    fs.copyFileSync(layout.payloadPath, path.join(stage, "payload.cjs"), fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(layout.pacPath, path.join(stage, "proxy.pac"), fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(layout.relayPath, path.join(stage, "gateway-relay.cjs"), fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(layout.safetyPath, path.join(stage, "runtime-safety.cjs"), fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(layout.manifestPath, path.join(stage, "tor-manifest.json"), fs.constants.COPYFILE_EXCL);
    fs.cpSync(layout.torRoot, path.join(stage, "tor"), { recursive: true, errorOnExist: true, force: false });
    if (runtimeIdentity(stage, enforcePackagedHashes) !== sourceIdentity) {
      throw new Error("A copia local do runtime nao confere.");
    }
    if (fs.existsSync(destination)) fs.renameSync(destination, previous);
    fs.renameSync(stage, destination);
    if (!matchesSource(destination)) throw new Error("O runtime promovido nao confere.");
    fs.rmSync(previous, { recursive: true, force: true });
    return path.join(destination, "payload.cjs");
  } catch (error) {
    if (fs.existsSync(previous)) {
      fs.rmSync(destination, { recursive: true, force: true });
      fs.renameSync(previous, destination);
    }
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

export function runtimeSourceReady(sourceRoot: string): boolean {
  try {
    verifyRuntime(sourceRoot, isPackagedRuntimeSource(sourceRoot));
    return true;
  } catch {
    return false;
  }
}
