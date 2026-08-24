[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$certificatePath = Join-Path $repositoryRoot "certificates\GoLiveBypassSafe.cer"
$publicCertificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($certificatePath)
$signingCertificate = Get-Item -LiteralPath ("Cert:\CurrentUser\My\" + $publicCertificate.Thumbprint)
if (-not $signingCertificate.HasPrivateKey) {
  throw "The private release key is unavailable. Run scripts\new-private-signing-certificate.ps1 on the signing machine."
}
if (-not (Test-Path -LiteralPath ("Cert:\CurrentUser\Root\" + $publicCertificate.Thumbprint))) {
  throw "The release certificate is not trusted for verification. Run scripts\new-private-signing-certificate.ps1 and approve the Windows root-certificate confirmation."
}

& npm.cmd run build:win
if ($LASTEXITCODE -ne 0) {
  throw "The Windows build failed with exit code $LASTEXITCODE."
}

$releaseDirectory = Join-Path $repositoryRoot "release"
$setup = Join-Path $releaseDirectory "GoLiveBypassSafeSetup.exe"
$portable = Join-Path $releaseDirectory "GoLiveBypassSafePortable.exe"
$trustScript = Join-Path $releaseDirectory "Trust-GoLiveBypassSafe.ps1"
$releaseCertificate = Join-Path $releaseDirectory "GoLiveBypassSafe.cer"
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "trust-and-install.ps1") -Destination $trustScript -Force
Copy-Item -LiteralPath $certificatePath -Destination $releaseCertificate -Force

$scriptSignature = Set-AuthenticodeSignature `
  -LiteralPath $trustScript `
  -Certificate $signingCertificate `
  -HashAlgorithm SHA256 `
  -IncludeChain All `
  -TimestampServer "http://timestamp.digicert.com"
if ($scriptSignature.Status -ne "Valid") {
  throw "The trust script signature is not valid: $($scriptSignature.StatusMessage)"
}

foreach ($artifact in @($setup, $portable, $trustScript)) {
  $signature = Get-AuthenticodeSignature -LiteralPath $artifact
  if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Thumbprint -ne $publicCertificate.Thumbprint) {
    throw "Release artifact '$artifact' does not have the expected valid signature."
  }
}

$manifest = Get-Content -LiteralPath (Join-Path $repositoryRoot "vendor\tor-manifest.json") -Raw | ConvertFrom-Json
$packagedTor = Join-Path $releaseDirectory "win-unpacked\resources\runtime\tor\tor\tor.exe"
$packagedTorHash = (Get-FileHash -LiteralPath $packagedTor -Algorithm SHA256).Hash.ToLowerInvariant()
if ($packagedTorHash -ne $manifest.files."tor/tor.exe") {
  throw "The packaged Tor executable no longer matches the pinned manifest."
}

$assets = @($setup, $portable, $trustScript, $releaseCertificate)
$checksums = $assets | ForEach-Object {
  "{0}  {1}" -f (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash, (Split-Path -Leaf $_)
}
[System.IO.File]::WriteAllLines((Join-Path $releaseDirectory "SHA256SUMS.txt"), $checksums, [System.Text.Encoding]::ASCII)
"Private release verified with certificate $($publicCertificate.Thumbprint)."
