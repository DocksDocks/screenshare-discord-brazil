import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Windows packaging", () => {
  it("builds versionless installer and recovery artifacts", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));

    expect(packageJson.build.win.target.map(({ target }: { target: string }) => target)).toEqual(["nsis", "portable"]);
    expect(packageJson.build.nsis.artifactName).toBe("GoLiveBypassSafeSetup.${ext}");
    expect(packageJson.build.nsis.include).toBe("build/installer.nsh");
    expect(packageJson.build.portable.artifactName).toBe("GoLiveBypassSafePortable.${ext}");
  });

  it("restores Discord only during a normal manager uninstall", () => {
    const installer = fs.readFileSync(path.join(projectRoot, "build", "installer.nsh"), "utf8");
    const main = fs.readFileSync(path.join(projectRoot, "electron", "main.ts"), "utf8");
    const updateGuard = installer.indexOf("${ifNot} ${isUpdated}");
    const clearErrors = installer.indexOf("ClearErrors");
    const restoreCommand = installer.indexOf("--restore-before-uninstall");
    const launchError = installer.indexOf("${if} ${Errors}");
    const abort = installer.indexOf("Abort");

    expect(updateGuard).toBeGreaterThanOrEqual(0);
    expect(clearErrors).toBeGreaterThan(updateGuard);
    expect(restoreCommand).toBeGreaterThan(updateGuard);
    expect(launchError).toBeGreaterThan(restoreCommand);
    expect(abort).toBeGreaterThan(restoreCommand);
    expect(installer).toContain("/SD IDOK");
    expect(main).toContain('process.argv.includes("--restore-before-uninstall")');
  });
});
