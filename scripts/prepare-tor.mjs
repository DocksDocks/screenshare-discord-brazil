import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION = "15.0.20";
const ARCHIVE = `tor-expert-bundle-windows-x86_64-${VERSION}.tar.gz`;
const SOURCE = `https://archive.torproject.org/tor-package-archive/torbrowser/${VERSION}/${ARCHIVE}`;
const ARCHIVE_SHA256 = "d59bff934e3ad876e1623e24ae60c19aeea56f50178093b9f86fba230639f949";
const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024;

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = join(projectRoot, "vendor");
const torRoot = join(vendorRoot, "tor");
const manifestPath = join(vendorRoot, "tor-manifest.json");

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function manifestFile(root, name) {
  if (typeof name !== "string" || name.length === 0 || name.includes("\0")) throw new Error("invalid manifest path");
  const portableName = name.replaceAll("\\", "/");
  const segments = portableName.split("/");
  if (
    portableName.startsWith("/") ||
    /^[a-z]:/i.test(portableName) ||
    segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes(":"))
  ) {
    throw new Error("invalid manifest path");
  }
  const resolvedRoot = resolve(root);
  if (lstatSync(resolvedRoot).isSymbolicLink()) throw new Error("Tor root links are not allowed");
  const file = resolve(resolvedRoot, ...segments);
  const physicalRoot = realpathSync.native(resolvedRoot);
  const physicalFile = realpathSync.native(file);
  const child = relative(physicalRoot, physicalFile);
  if (child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error("manifest path escapes Tor root");
  return physicalFile;
}

function filesBelow(root, current = root) {
  if (lstatSync(resolve(root)).isSymbolicLink()) throw new Error("Tor root links are not allowed");
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) throw new Error("links are not allowed in the Tor bundle");
    const file = join(current, entry.name);
    const name = relative(root, file).replaceAll("\\", "/");
    manifestFile(root, name);
    if (entry.isDirectory()) return filesBelow(root, file);
    if (entry.isFile()) return [name];
    throw new Error("unsupported entry in the Tor bundle");
  });
}

function existingBundleIsValid() {
  if (!existsSync(manifestPath) || !existsSync(torRoot)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      manifest.schema !== 1 ||
      manifest.archiveSha256 !== ARCHIVE_SHA256 ||
      manifest.version !== VERSION ||
      manifest.files === null ||
      typeof manifest.files !== "object" ||
      Array.isArray(manifest.files) ||
      typeof manifest.files["tor/tor.exe"] !== "string"
    ) {
      return false;
    }
    const listedFiles = Object.keys(manifest.files).sort();
    const actualFiles = filesBelow(torRoot).sort();
    if (listedFiles.length !== actualFiles.length || listedFiles.some((name, index) => name !== actualFiles[index])) {
      return false;
    }
    return Object.entries(manifest.files).every(([name, hash]) => {
      if (typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash)) return false;
      const file = manifestFile(torRoot, name);
      return existsSync(file) && statSync(file).isFile() && sha256File(file) === hash.toLowerCase();
    });
  } catch {
    return false;
  }
}

if (existingBundleIsValid()) {
  console.log(`[tor] verified ${VERSION}`);
  process.exit(0);
}

mkdirSync(vendorRoot, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "golivebypass-tor-"));
const archivePath = join(work, basename(SOURCE));
const extractRoot = join(work, "extract");
mkdirSync(extractRoot);

try {
  console.log(`[tor] downloading ${SOURCE}`);
  const response = await fetch(SOURCE, { redirect: "follow" });
  if (!response.ok || new URL(response.url).hostname !== "archive.torproject.org") {
    throw new Error(`download refused: HTTP ${response.status} from ${response.url}`);
  }

  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_ARCHIVE_BYTES) {
    throw new Error(`archive is unexpectedly large: ${declaredSize} bytes`);
  }

  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error(`archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
  const archiveHash = createHash("sha256").update(archive).digest("hex");
  if (archiveHash !== ARCHIVE_SHA256) {
    throw new Error(`archive hash mismatch: expected ${ARCHIVE_SHA256}, received ${archiveHash}`);
  }
  writeFileSync(archivePath, archive, { flag: "wx" });

  const extracted = spawnSync(
    "tar.exe",
    [
      "-xzf",
      archivePath,
      "-C",
      extractRoot,
      "data/geoip",
      "data/geoip6",
      "data/torrc-defaults",
      "docs",
      "tor/tor.exe",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (extracted.status !== 0) throw new Error(`tar failed: ${extracted.stderr.trim()}`);

  const files = Object.fromEntries(
    filesBelow(extractRoot)
      .sort()
      .map((name) => [name, sha256File(join(extractRoot, name))]),
  );
  if (!("tor/tor.exe" in files) || !("data/geoip" in files) || !("data/geoip6" in files)) {
    throw new Error("expert bundle is missing required Tor files");
  }

  rmSync(torRoot, { recursive: true, force: true });
  renameSync(extractRoot, torRoot);
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ schema: 1, version: VERSION, source: SOURCE, archiveSha256: ARCHIVE_SHA256, files }, null, 2)}\n`,
  );
  console.log(`[tor] prepared ${Object.keys(files).length} verified files`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
