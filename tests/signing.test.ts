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
    expect(script).toContain("-Wait -PassThru");
    expect(script).toContain("$installer.ExitCode");
  });
});
