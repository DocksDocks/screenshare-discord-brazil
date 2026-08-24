[CmdletBinding()]
param(
  [string]$CertificatePath,
  [string]$SetupPath,
  [switch]$RemoveTrust
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$expectedThumbprint = "4960FAD2932D56589F1DADFF3CBEE143FAA9EB35"
$expectedCertificateSha256 = "D5D0C0EE02D56A38910CF223A55EDFAA28223AFF8AABF54DCD322F0DB6EB078A"
if ([string]::IsNullOrWhiteSpace($CertificatePath)) {
  $CertificatePath = Join-Path $PSScriptRoot "GoLiveBypassSafe.cer"
}
if (-not $RemoveTrust -and [string]::IsNullOrWhiteSpace($SetupPath)) {
  $SetupPath = Join-Path $PSScriptRoot "GoLiveBypassSafeSetup.exe"
}

$certificatePath = (Resolve-Path -LiteralPath $CertificatePath).Path
if ((Get-FileHash -LiteralPath $certificatePath -Algorithm SHA256).Hash -ne $expectedCertificateSha256) {
  throw "The public certificate hash does not match this release."
}

$certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($certificatePath)
if ($certificate.Thumbprint -ne $expectedThumbprint) {
  throw "The public certificate thumbprint does not match this release."
}
if ($certificate.PublicKey.Oid.Value -ne "1.2.840.113549.1.1.1") {
  throw "The release certificate is not RSA."
}
$hasCodeSigningEku = $false
foreach ($usage in $certificate.EnhancedKeyUsageList) {
  $oid = if ($usage.ObjectId -is [string]) { $usage.ObjectId } else { $usage.ObjectId.Value }
  if ($oid -eq "1.3.6.1.5.5.7.3.3") {
    $hasCodeSigningEku = $true
  }
}
if (-not $hasCodeSigningEku) {
  throw "The release certificate is not authorized for code signing."
}

$stores = @("Cert:\CurrentUser\Root", "Cert:\CurrentUser\TrustedPublisher")
if ($RemoveTrust) {
  $scriptSignature = Get-AuthenticodeSignature -LiteralPath $PSCommandPath
  if ($scriptSignature.Status -ne "Valid" -or $scriptSignature.SignerCertificate.Thumbprint -ne $expectedThumbprint) {
    throw "This trust script does not have the expected valid signature."
  }
  foreach ($store in $stores) {
    $trustedCertificate = Join-Path $store $expectedThumbprint
    if (Test-Path -LiteralPath $trustedCertificate) {
      Remove-Item -LiteralPath $trustedCertificate -Force
    }
  }
  return
}

foreach ($store in $stores) {
  if (-not (Test-Path -LiteralPath (Join-Path $store $expectedThumbprint))) {
    Import-Certificate -FilePath $certificatePath -CertStoreLocation $store | Out-Null
  }
}

$scriptSignature = Get-AuthenticodeSignature -LiteralPath $PSCommandPath
if ($scriptSignature.Status -ne "Valid" -or $scriptSignature.SignerCertificate.Thumbprint -ne $expectedThumbprint) {
  throw "This trust script does not have the expected valid signature."
}

$setupPath = (Resolve-Path -LiteralPath $SetupPath).Path
$signature = Get-AuthenticodeSignature -LiteralPath $setupPath
if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Thumbprint -ne $expectedThumbprint) {
  throw "The installer does not have the expected valid signature."
}

$installer = Start-Process -FilePath $setupPath -Wait -PassThru
if ($installer.ExitCode -ne 0) {
  throw "The installer failed with exit code $($installer.ExitCode)."
}
