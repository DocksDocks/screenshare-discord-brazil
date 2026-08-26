import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("release security", () => {
  it("builds explicitly unsigned without certificate or trust infrastructure", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
    const build = fs.readFileSync(path.resolve("scripts", "build-release.ps1"), "utf8");

    expect(packageJson.build.win.signExecutable).toBe(false);
    expect(packageJson.engines.node).toBe("24.18.0");
    expect(packageJson.build.win.forceCodeSigning).toBeUndefined();
    expect(packageJson.build.win.signExts).toBeUndefined();
    expect(packageJson.build.win.signtoolOptions).toBeUndefined();
    expect(build).not.toContain("Authenticode");
    expect(build).not.toContain("Certificate");
    expect(build).not.toContain("Sac-GoLiveBypassSafe");
    expect(build).not.toContain("Trust-GoLiveBypassSafe");
    expect(fs.existsSync(path.resolve("scripts", "sac-supervisor.ps1"))).toBe(false);
    expect(fs.existsSync(path.resolve("scripts", "new-private-signing-certificate.ps1"))).toBe(false);
    expect(fs.existsSync(path.resolve("certificates", "GoLiveBypassSafe.cer"))).toBe(false);
  });

  it("requires manual SAC control while preserving hash authentication and rollback", () => {
    const controller = fs.readFileSync(path.resolve("scripts", "install-release.ps1"), "utf8");
    const batch = fs.readFileSync(path.resolve("scripts", "Install-GoLiveBypassSafe.bat"), "utf8");
    const build = fs.readFileSync(path.resolve("scripts", "build-release.ps1"), "utf8");

    expect(batch).toContain('"%~dp0Install-GoLiveBypassSafe.ps1"');
    expect(batch).not.toContain("%*");
    expect(batch).not.toContain("RunAs");
    expect(controller).toContain('throw "smart_app_control_must_be_off"');
    expect(controller).toContain('@("1", "2") -ccontains $sacState');
    expect(controller).toContain('smart_app_control=reenable_manually');
    expect(controller).not.toContain("Set-SacState");
    expect(controller).not.toContain("CiTool");
    expect(controller).not.toContain("-Verb RunAs");
    expect(controller).not.toContain("Authenticode");
    expect(controller).not.toContain("Cert:\\");
    expect(controller).not.toContain("Import-Certificate");
    expect(controller).not.toContain("RemoveTrust");
    expect(controller).toContain('GOLIVE_AUTOMATION_ROLLBACK_UNCONFIRMED');
    expect(controller).toContain('"--restore-before-uninstall"');
    expect(controller).toContain("Add-DescendantProcesses $current $knownProcesses");
    expect(controller).toContain("$creationTime -ge $KnownProcesses[$parentProcessId]");
    expect(controller).toContain("([DateTimeOffset]$process.StartTime).ToUnixTimeMilliseconds()");
    expect(controller).toContain("[Diagnostics.Process]::GetProcessById");
    expect(controller).toContain("$null = $candidate.Handle");
    expect(controller).toContain("$KnownProcesses.Remove($processId)");
    expect(controller).toContain("if ($process.ExitCode -ne 0)");
    expect(controller).toContain("process_tree_termination_unconfirmed");
    expect(controller).not.toContain("taskkill.exe");
    expect(controller).toContain('$installRegistrySubKey = "Software\\2bab6ef2-82b6-538a-983f-87f4c93796a6"');
    expect(controller).toContain("Get-LockedManagerTreeSha256 $installedManagerRoot $installedUninstallerPath");
    expect(controller).toContain("manager_tree_reparse_point");
    expect(controller).toContain('[Threading.Mutex]::new($false, "Global\\GoLiveBypassSafeReleaseInstall")');
    expect(controller).toContain("catch [Threading.AbandonedMutexException]");
    expect(controller).toContain("$script:processTerminationUnconfirmed = $true");
    expect(controller).not.toContain("$process.Kill()");
    expect(controller).toContain("if ($processTerminationUnconfirmed)");
    expect(controller).toContain("manager_preserved=$managerPreserved");
    expect(controller).toContain('throw "existing_manager_must_be_removed"');
    expect(controller).toContain('throw "manager_uninstall_registration_missing"');
    expect(controller).toContain("Test-UninstallRegistration $installedUninstallerPath");
    expect(controller).toContain("Assert-RegularFileWithoutReparsePoints $registeredManager.UninstallerPath");
    expect(controller.indexOf("if ($null -eq $registeredManager)")).toBeLessThan(
      controller.indexOf("Invoke-BoundedProcess $setupPath"),
    );
    expect(controller).not.toContain("Remove-ManagerRoot");
    expect(controller).not.toContain("Remove-NewRegistrationKeys");
    expect(controller).not.toContain("Remove-NewShortcuts");
    expect(controller).not.toContain("Invoke-BoundedProcess $installedUninstallerPath");

    const setupHash = controller.indexOf("Get-LockedSha256 $locks[$setupPath]");
    const setupRun = controller.indexOf("Invoke-BoundedProcess $setupPath ('/S /D={0}' -f $installedManagerRoot)");
    const managerHash = controller.indexOf("Get-LockedManagerTreeSha256 $installedManagerRoot $installedUninstallerPath", setupRun);
    const managerHashCheck = controller.indexOf("$managerTreeSha256 -cne $expectedManagerTreeSha256", managerHash);
    const managerTreeCheck = controller.indexOf("Assert-ManagerTreeMatchesLocks $installedManagerRoot $installedUninstallerPath", managerHashCheck);
    const managerStarted = controller.indexOf("$managerStarted = $true", managerTreeCheck);
    const managerRun = controller.indexOf('Invoke-BoundedProcess $installedManagerPath "--install-and-exit"', managerStarted);
    const managerRestore = controller.indexOf('Invoke-BoundedProcess $installedManagerPath "--restore-before-uninstall"');
    const terminationGuard = controller.indexOf("if ($processTerminationUnconfirmed)", managerRun);
    const lockRelease = controller.indexOf("foreach ($lock in $locks.Values)", managerRestore);
    expect(setupHash).toBeGreaterThanOrEqual(0);
    expect(setupRun).toBeGreaterThan(setupHash);
    expect(managerHash).toBeGreaterThan(setupRun);
    expect(managerHashCheck).toBeGreaterThan(managerHash);
    expect(managerTreeCheck).toBeGreaterThan(managerHashCheck);
    expect(managerStarted).toBeGreaterThan(managerTreeCheck);
    expect(managerRun).toBeGreaterThan(managerStarted);
    expect(terminationGuard).toBeGreaterThan(managerRun);
    expect(managerRestore).toBeGreaterThan(terminationGuard);
    expect(lockRelease).toBeGreaterThan(managerRestore);

    expect(build).toContain('Replace("__SETUP_SHA256__"');
    expect(build).toContain('Replace("__MANAGER_TREE_SHA256__"');
    expect(build).toContain("Get-FileTreeSha256 (Split-Path -Parent $unpackedManager)");
    expect(build).toContain('Replace("__SOURCE_COMMIT__"');
    expect(build).toContain('$actualNodeVersion -ne "v$($package.engines.node)"');
    expect(build).toContain('$assets = @($setup, $installerScript, $batchInstaller, $sourceProvenance)');
    expect(build).not.toContain("$portable");
  });
});
