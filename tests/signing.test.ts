import { createHash, X509Certificate } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const certificatePath = path.resolve("certificates", "GoLiveBypassSafe.cer");
const certificate = new X509Certificate(fs.readFileSync(certificatePath));
const thumbprint = certificate.fingerprint.replaceAll(":", "");
const sha256 = createHash("sha256").update(fs.readFileSync(certificatePath)).digest("hex").toUpperCase();

describe("private release signing", () => {
  it("pins the non-CA RSA code-signing certificate", () => {
    expect(certificate.subject).toBe("CN=GoLiveBypass Safe Private Release");
    expect(certificate.ca).toBe(false);
    expect(certificate.publicKey.asymmetricKeyType).toBe("rsa");
    expect(certificate.keyUsage).toContain("1.3.6.1.5.5.7.3.3");
    expect(thumbprint).toBe("4960FAD2932D56589F1DADFF3CBEE143FAA9EB35");
    expect(sha256).toBe("D5D0C0EE02D56A38910CF223A55EDFAA28223AFF8AABF54DCD322F0DB6EB078A");
  });

  it("uses the exact certificate and excludes pinned Tor from signing", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
    expect(packageJson.build.win.forceCodeSigning).toBe(true);
    expect(packageJson.build.win.signExts).toContain("!tor.exe");
    expect(packageJson.build.win.signtoolOptions.certificateSha1).toBe(thumbprint);
  });

  it("pins the same certificate in the friend trust script", () => {
    const script = fs.readFileSync(path.resolve("scripts", "trust-and-install.ps1"), "utf8");
    expect(script).toContain(`$expectedThumbprint = "${thumbprint}"`);
    expect(script).toContain(`$expectedCertificateSha256 = "${sha256}"`);
    expect(script).toContain("Cert:\\CurrentUser\\Root");
    expect(script).toContain("Cert:\\CurrentUser\\TrustedPublisher");
    expect(script).toContain("[switch]$RemoveTrust");
    expect(script).toContain('Invoke-BoundedProcess $setupPath "/S"');
    expect(script).toContain('Invoke-BoundedProcess $portablePath "--install-and-exit"');
    expect(script).toContain("-Verb RunAs");
    expect(script.match(/-Verb RunAs/g)).toHaveLength(1);
    expect(script).not.toContain("Read-Host");
    expect(script).not.toContain("DESATIVAR");
    expect(script).not.toContain("EncodedCommand");
  });

  it("limits elevation to the signed SAC supervisor and rolls back over a bounded channel", () => {
    const controller = fs.readFileSync(path.resolve("scripts", "trust-and-install.ps1"), "utf8");
    const helper = fs.readFileSync(path.resolve("scripts", "sac-supervisor.ps1"), "utf8");
    const batch = fs.readFileSync(path.resolve("scripts", "Install-GoLiveBypassSafe.bat"), "utf8");
    const build = fs.readFileSync(path.resolve("scripts", "build-private-release.ps1"), "utf8");

    expect(batch).toContain('"%~dp0Trust-GoLiveBypassSafe.ps1"');
    expect(batch).not.toContain("%*");
    expect(batch).not.toContain("RunAs");
    expect(controller).toContain('Join-Path $PSScriptRoot "Sac-GoLiveBypassSafe.ps1"');
    expect(controller).toContain('GOLIVE_AUTOMATION_ROLLBACK_UNCONFIRMED');
    expect(controller).toContain('COMMIT $token');
    expect(controller).toContain('ABORT $token');
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
    expect(controller).toContain('$applicationRollbackConfirmed');
    expect(helper).not.toContain("HKLM:\\");
    expect(helper).toContain('SYSTEM\\CurrentControlSet\\Control\\CI\\Policy');
    expect(helper).toContain('Set-SacState 0');
    expect(helper).toContain('Set-SacState 1');
    expect(helper).toContain('"COMMIT $Token"');
    expect(helper).toContain('"ABORT $Token"');
    expect(helper).toContain('"ROLLED_BACK $Token"');
    expect(helper).toContain('"ROLLBACK_READY $Token"');
    expect(helper).not.toContain("CHECK_CLEANUP");
    expect(helper).not.toContain("CLEANUP_READY");
    expect(helper).toContain('[Threading.Mutex]::new($false, "Local\\GoLiveBypassSafeCleanup-$Token")');
    expect(helper).toContain("catch [Threading.AbandonedMutexException]");
    expect(helper).toContain('throw "sac_success_restore_unconfirmed"');
    expect(helper).toContain("--list-policies --json");
    expect(helper).toContain('"VerifiedAndReputableDesktop"');
    expect(helper).toContain('"VerifiedAndReputableDesktopEvaluation"');
    const commit = helper.indexOf('if ($command -cne "COMMIT $Token")');
    const successRestore = helper.indexOf("Set-SacState 1", commit);
    const successRefresh = helper.indexOf("Invoke-CiRefresh", successRestore);
    const successVerification = helper.indexOf('throw "sac_success_restore_unconfirmed"', successRefresh);
    const committed = helper.indexOf('$writer.WriteLine("COMMITTED $Token")', successVerification);
    expect(successRestore).toBeGreaterThan(commit);
    expect(successRefresh).toBeGreaterThan(successRestore);
    expect(successVerification).toBeGreaterThan(successRefresh);
    expect(committed).toBeGreaterThan(successVerification);
    expect(controller).toContain('$commitResponse -ceq "ROLLED_BACK $token"');
    expect(controller).toContain('$commitResponse -ceq "ROLLBACK_READY $token"');
    expect(controller).toContain('$applicationRollbackSafe = $priorSacState -ne "1"');
    expect(controller).toContain("$portableStarted -and $applicationRollbackSafe");
    expect(controller).toContain('[Threading.Mutex]::new($true, $cleanupMutexName, [ref]$cleanupMutexCreated)');
    expect(controller).toContain("catch [Threading.AbandonedMutexException]");
    const releaseBeforeCommit = controller.indexOf("Exit-CleanupMutex", controller.indexOf('$stage = "commit"'));
    const commitRequest = controller.indexOf('$writer.WriteLine("COMMIT $token")');
    const reacquireAfterFailedRestore = controller.indexOf("Enter-CleanupMutex", controller.indexOf('$commitResponse -ceq "ROLLBACK_READY $token"'));
    expect(releaseBeforeCommit).toBeGreaterThan(controller.indexOf('$stage = "commit"'));
    expect(commitRequest).toBeGreaterThan(releaseBeforeCommit);
    expect(reacquireAfterFailedRestore).toBeGreaterThan(controller.indexOf('$commitResponse -ceq "ROLLBACK_READY $token"'));
    expect(controller.indexOf('Invoke-BoundedProcess $portablePath "--restore-before-uninstall"')).toBeLessThan(
      controller.indexOf("Exit-CleanupMutex", controller.indexOf("} catch {", controller.indexOf("$successRecord"))),
    );
    expect(build).toContain('Replace("__HELPER_SHA256__"');
    expect(build).toContain('Replace("__SOURCE_COMMIT__"');
    expect(build).toContain('$assets = @($setup, $portable, $trustScript, $sacHelper, $batchInstaller, $releaseCertificate, $sourceProvenance)');
  });
});
