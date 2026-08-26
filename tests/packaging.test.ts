import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Windows packaging", () => {
  it("builds versionless installer and recovery artifacts", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
    const packageLock = JSON.parse(fs.readFileSync(path.join(projectRoot, "package-lock.json"), "utf8"));

    expect(packageJson.version).toBe("0.2.2");
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[""].version).toBe(packageJson.version);
    expect(packageJson.packageManager).toBe("npm@11.16.0");
    expect(packageJson.engines.npm).toBe("11.16.0");
    expect(packageJson.build.win.target.map(({ target }: { target: string }) => target)).toEqual(["nsis", "portable"]);
    expect(packageJson.build.nsis.artifactName).toBe("GoLiveBypassSafeSetup.${ext}");
    expect(packageJson.build.nsis.include).toBe("build/installer.nsh");
    expect(packageJson.build.portable.artifactName).toBe("GoLiveBypassSafePortable.${ext}");
    expect(packageJson.scripts["build:win"]).toContain("--publish never");
  });

  it("gates private releases on source provenance and verifies final packaged state", () => {
    const build = fs.readFileSync(path.join(projectRoot, "scripts", "build-private-release.ps1"), "utf8");

    expect(build).toContain("[switch]$AllowDirty");
    expect(build).toContain("status --porcelain=v1 --untracked-files=all");
    expect(build).toContain("cat-file -t $tagName");
    expect(build).toContain('$package.version -ne "0.2.2"');
    expect(build).toContain("npm.cmd ci");
    expect(build).toContain("--dangerously-allow-all-scripts=false");
    expect(build).toContain("npm.cmd run verify");
    expect(build).toContain("The release source changed during dependency installation or build");
    expect(build.lastIndexOf("The release source changed while artifacts were being verified and signed")).toBeGreaterThan(
      build.indexOf("Set-AuthenticodeSignature"),
    );
    expect(build).toContain("RunAsNode is Disabled");
    expect(build).toContain("The packaged Tor file tree no longer matches the manifest");
    expect(build).toContain('"state=$sourceState"');
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

  it("runs automated installation headlessly before taking the GUI instance lock", () => {
    const main = fs.readFileSync(path.join(projectRoot, "electron", "main.ts"), "utf8");
    const installMode = main.indexOf('process.argv.includes("--install-and-exit")');
    const installOperation = main.indexOf('runCommand(installOrRepair, "GOLIVE_INSTALL_OK")');
    const instanceLock = main.indexOf("app.requestSingleInstanceLock()");

    expect(installMode).toBeGreaterThanOrEqual(0);
    expect(installOperation).toBeGreaterThan(installMode);
    expect(instanceLock).toBeGreaterThan(installOperation);
    expect(main).toContain("conflicting_modes");
    expect(main).not.toContain("runCommand(restoreOriginalInstallations, \"GOLIVE_INSTALL_OK\")");
  });
});
