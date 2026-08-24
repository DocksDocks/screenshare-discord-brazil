[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$subject = "CN=GoLiveBypass Safe Private Release"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$publicCertificate = Join-Path $repositoryRoot "certificates\GoLiveBypassSafe.cer"
$matches = @(
  Get-ChildItem -Path "Cert:\CurrentUser\My" -CodeSigningCert |
    Where-Object { $_.Subject -eq $subject -and $_.NotAfter -gt (Get-Date) }
)

if ($matches.Count -gt 1) {
  throw "More than one current code-signing certificate has subject '$subject'. Remove the ambiguity before continuing."
}

if ($matches.Count -eq 0) {
  $certificate = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $subject `
    -FriendlyName "GoLiveBypass Safe private release signing" `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyUsage DigitalSignature `
    -KeyExportPolicy NonExportable `
    -NotAfter (Get-Date).AddYears(3)
} else {
  $certificate = $matches[0]
}

if (-not $certificate.HasPrivateKey) {
  throw "The release certificate does not have an accessible private key."
}

Export-Certificate -Cert $certificate -FilePath $publicCertificate -Type CERT -Force | Out-Null
foreach ($store in @("Cert:\CurrentUser\Root", "Cert:\CurrentUser\TrustedPublisher")) {
  if (-not (Test-Path -LiteralPath (Join-Path $store $certificate.Thumbprint))) {
    Import-Certificate -FilePath $publicCertificate -CertStoreLocation $store | Out-Null
  }
}

$sha256 = (Get-FileHash -LiteralPath $publicCertificate -Algorithm SHA256).Hash
"Certificate: $publicCertificate"
"Thumbprint: $($certificate.Thumbprint)"
"SHA256: $sha256"
