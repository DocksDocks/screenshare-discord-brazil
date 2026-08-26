import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Windows packaging", () => {
  it("builds versionless installer and recovery artifacts", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
    const packageLock = JSON.parse(fs.readFileSync(path.join(projectRoot, "package-lock.json"), "utf8"));

    expect(packageJson.version).toBe("0.2.4");
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[""].version).toBe(packageJson.version);
    expect(packageJson.packageManager).toBe("npm@11.16.0");
    expect(packageJson.engines.npm).toBe("11.16.0");
    expect(packageJson.build.win.target.map(({ target }: { target: string }) => target)).toEqual(["nsis"]);
    expect(packageJson.build.nsis.artifactName).toBe("GoLiveBypassSafeSetup.${ext}");
    expect(packageJson.build.nsis.include).toBe("build/installer.nsh");
    expect(packageJson.build.portable).toBeUndefined();
    expect(packageJson.scripts["build:win"]).toContain("--publish never");
  });

  it("gates private releases on source provenance and verifies final packaged state", () => {
    const build = fs.readFileSync(path.join(projectRoot, "scripts", "build-private-release.ps1"), "utf8");

    expect(build).toContain("[switch]$AllowDirty");
    expect(build).toContain("status --porcelain=v1 --untracked-files=all");
    expect(build).toContain("cat-file -t $tagName");
    expect(build).toContain('$package.version -ne "0.2.4"');
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
    expect(build).toContain('$bundleName = "GoLiveBypassSafe-v$($package.version).zip"');
    expect(build).toContain('create-release-bundle.ps1") -ReleaseDirectory $releaseDirectory');
    expect(build).toContain("The release bundle was not created at the expected path");
    expect(build).toContain('"builder-effective-config.yaml"');
    expect(build).toContain("$expectedNames = @($bundleName)");
    expect(build).not.toContain("GoLiveBypassSafePortable.exe");
  });

  it("creates the same verified one-download bundle from the same files", () => {
    const releaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "golive-release-bundle-"));
    const script = path.join(projectRoot, "scripts", "create-release-bundle.ps1");
    const names = [
      "GoLiveBypassSafe.cer",
      "GoLiveBypassSafeSetup.exe",
      "Install-GoLiveBypassSafe.bat",
      "Sac-GoLiveBypassSafe.ps1",
      "SHA256SUMS.txt",
      "SOURCE.txt",
      "Trust-GoLiveBypassSafe.ps1",
    ];
    const bundle = path.join(releaseDirectory, "GoLiveBypassSafe-v0.2.4.zip");
    const runBundle = () =>
      spawnSync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-ReleaseDirectory", releaseDirectory, "-Version", "0.2.4"],
        { encoding: "utf8", windowsHide: true },
      );
    const hash = () => createHash("sha256").update(fs.readFileSync(bundle)).digest("hex");

    try {
      for (const name of names) fs.writeFileSync(path.join(releaseDirectory, name), `fixture:${name}\n`);
      const first = runBundle();
      expect(first.stderr).toBe("");
      expect(first.status).toBe(0);
      const firstHash = hash();

      fs.rmSync(bundle);
      const changedTime = new Date("2026-08-26T12:00:00Z");
      for (const name of names) fs.utimesSync(path.join(releaseDirectory, name), changedTime, changedTime);
      const second = runBundle();
      expect(second.stderr).toBe("");
      expect(second.status).toBe(0);
      expect(hash()).toBe(firstHash);
    } finally {
      fs.rmSync(releaseDirectory, { recursive: true, force: true });
    }
  }, 30_000);

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
