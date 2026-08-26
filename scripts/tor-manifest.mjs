import { existsSync, readFileSync, writeFileSync } from "node:fs";

export function writeManifestIfChanged(manifestPath, serializedManifest) {
  if (
    !existsSync(manifestPath) ||
    readFileSync(manifestPath, "utf8").replaceAll("\r\n", "\n") !== serializedManifest
  ) {
    writeFileSync(manifestPath, serializedManifest);
  }
}
