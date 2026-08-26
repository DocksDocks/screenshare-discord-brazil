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

    expect(packageJson.version).toBe("0.2.5");
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[""].version).toBe(packageJson.version);
    expect(packageJson.packageManager).toBe("npm@11.16.0");
    expect(packageJson.engines.npm).toBe("11.16.0");
    expect(packageJson.build.win.target.map(({ target }: { target: string }) => target)).toEqual(["nsis"]);
    expect(packageJson.build.nsis.artifactName).toBe("GoLiveBypassSafeSetup.${ext}");
    expect(packageJson.build.nsis.include).toBe("build/installer.nsh");
    expect(packageJson.build.portable).toBeUndefined();
    expect(packageJson.build.win.signExecutable).toBe(false);
    expect(packageJson.scripts["build:win"]).toContain("scripts/build-nsis.ps1");
    expect(packageJson.scripts["build:release"]).toContain("scripts/build-release.ps1");
  });

  it("gates releases on source provenance and verifies final packaged state", () => {
    const build = fs.readFileSync(path.join(projectRoot, "scripts", "build-release.ps1"), "utf8");

    expect(build).toContain("[switch]$AllowDirty");
    expect(build).toContain("status --porcelain=v1 --untracked-files=all");
    expect(build).toContain("cat-file -t $tagName");
    expect(build).toContain('$package.version -ne "0.2.5"');
    expect(build).toContain("npm.cmd ci");
    expect(build).toContain("--dangerously-allow-all-scripts=false");
    expect(build).toContain("npm.cmd run verify");
    expect(build).toContain("The release source changed during dependency installation or build");
    expect(build.lastIndexOf("The release source changed while artifacts were being verified")).toBeGreaterThan(
      build.indexOf("create-release-bundle.ps1"),
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
      "GoLiveBypassSafeSetup.exe",
      "Install-GoLiveBypassSafe.bat",
      "Install-GoLiveBypassSafe.ps1",
      "SHA256SUMS.txt",
      "SOURCE.txt",
    ];
    const bundle = path.join(releaseDirectory, "GoLiveBypassSafe-v0.2.5.zip");
    const runBundle = () =>
      spawnSync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-ReleaseDirectory", releaseDirectory, "-Version", "0.2.5"],
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
    const nsisBuild = fs.readFileSync(path.join(projectRoot, "scripts", "build-nsis.ps1"), "utf8");
    const main = fs.readFileSync(path.join(projectRoot, "electron", "main.ts"), "utf8");
    const updateGuard = installer.indexOf("${ifNot} ${isUpdated}");
    const clearErrors = installer.indexOf("ClearErrors", updateGuard);
    const restoreCommand = installer.indexOf("--restore-before-uninstall", updateGuard);
    const launchError = installer.indexOf("${if} ${Errors}", updateGuard);
    const abort = installer.indexOf("Abort", updateGuard);

    expect(updateGuard).toBeGreaterThanOrEqual(0);
    expect(clearErrors).toBeGreaterThan(updateGuard);
    expect(restoreCommand).toBeGreaterThan(updateGuard);
    expect(launchError).toBeGreaterThan(restoreCommand);
    expect(abort).toBeGreaterThan(restoreCommand);
    expect(installer).toContain("/SD IDOK");
    expect(installer).toContain("!macro customCheckAppRunning");
    expect(installer).toContain('nsProcess::_FindProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"');
    expect(installer).not.toContain("nsProcess::_KillProcess");
    expect(installer).not.toContain("taskkill");
    expect(nsisBuild).toContain("installUtil.nsh");
    expect(nsisBuild).toContain("97BD546B5CD2AAF16B77BC9E2BE8A18962DD74AB5C4D23B35B163CA89BF4DD2A");
    expect(nsisBuild).toContain("Function uninstallOldVersion");
    expect(nsisBuild).toContain('Remove-ExactSection $original "Function GetInQuotes`n"');
    expect(nsisBuild).toContain('Remove-ExactSection $patched "Function GetFileParent`n"');
    expect(nsisBuild).toContain("$patched.Substring(0, $functionStart) + $safeFunction");
    expect(nsisBuild).toContain("[IO.File]::WriteAllBytes($templatePath, $originalBytes)");
    expect(nsisBuild).toContain("& $builderPath --win --x64 --publish never");
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

  it("keeps CI read-only and isolates tag release permissions", () => {
    const ci = fs.readFileSync(path.join(projectRoot, ".github", "workflows", "ci.yml"), "utf8");
    const release = fs.readFileSync(path.join(projectRoot, ".github", "workflows", "release.yml"), "utf8");
    const actionReferences = (workflow: string) =>
      [...workflow.matchAll(/^\s*uses:\s+([^\s#]+)/gm)].map((match) => match[1]);
    const expectedCiActions = [
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    ];
    const expectedReleaseActions = [
      ...expectedCiActions,
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    ];

    expect(ci).toContain("pull_request:");
    expect(ci).not.toContain("pull_request_target");
    expect(ci).toContain("permissions:\n  contents: read");
    expect(ci).toContain("persist-credentials: false");
    expect(ci).toContain("timeout-minutes:");
    expect(ci).toContain("cancel-in-progress: true");
    expect(ci).toContain("node-version: 24.18.0");
    expect(ci).toContain("npm.cmd install --global npm@11.16.0");
    expect(ci).toContain("npm.cmd run verify");
    expect(actionReferences(ci)).toEqual(expectedCiActions);
    expect(ci).not.toContain("write-all");
    expect(ci).not.toMatch(/^\s+[a-z-]+:\s+write\s*$/m);

    expect(release).toContain('      - "v*.*.*"');
    expect(release).toContain("contents: read");
    expect(release).toContain("contents: write");
    expect(release).toContain("persist-credentials: false");
    expect(release).toContain("fetch-depth: 0");
    expect(release).toContain("git merge-base --is-ancestor HEAD origin/main");
    expect(release).toContain("group: release");
    expect(release).toContain("cancel-in-progress: false");
    expect(release).toContain("queue: max");
    expect(release).toContain("build:\n    runs-on: windows-latest");
    expect(release).toContain("publish:\n    needs: build");
    expect(release).toContain("npm.cmd run build:release");
    expect(release).toContain("compression-level: 0");
    expect(release).toContain("overwrite: true");
    expect(release).toContain("gh release create $env:RELEASE_TAG --repo $env:REPOSITORY --draft --verify-tag");
    expect(release).toContain("gh release upload $env:RELEASE_TAG $zip --repo $env:REPOSITORY --clobber");
    expect(release).toContain("Existing public release already matches the verified ZIP");
    expect(release).toContain("Remote annotated tag object changed");
    expect(release).toContain("$assets.Count -ne 1");
    expect(release).toContain('$asset.state -cne "uploaded"');
    expect(release).toContain("compare/$env:SOURCE_COMMIT...main");
    expect(release).toContain("-F draft=false -f make_latest=legacy");
    expect(release).toContain("-F draft=true");
    expect(release).toContain("-not $redrafted.draft");
    expect(release).not.toContain("--latest");
    expect(release).not.toContain("pull_request_target");
    expect(actionReferences(release)).toEqual(expectedReleaseActions);
    expect(release).not.toContain("write-all");
    expect(release.match(/^\s+contents:\s+write\s*$/gm)).toHaveLength(1);
    expect(release.indexOf("contents: write")).toBeGreaterThan(release.indexOf("publish:"));
  });
});
