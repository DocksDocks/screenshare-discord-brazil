[CmdletBinding()]
param(
  [switch]$AllowDirty
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-FileTreeSha256([string]$Root) {
  $rootPath = (Resolve-Path -LiteralPath $Root).Path
  $pending = New-Object Collections.Generic.Queue[string]
  $relativePaths = New-Object Collections.Generic.List[string]
  $pending.Enqueue($rootPath)
  while ($pending.Count -ne 0) {
    $directory = $pending.Dequeue()
    foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "The unpacked manager contains a reparse point."
      }
      if ($item.PSIsContainer) {
        $pending.Enqueue($item.FullName)
      } else {
        $relativePaths.Add($item.FullName.Substring($rootPath.Length + 1).Replace("\", "/"))
      }
    }
  }
  $relativePaths.Sort([StringComparer]::Ordinal)
  $canonical = New-Object Text.StringBuilder
  foreach ($relativePath in $relativePaths) {
    $fileHash = (Get-FileHash -LiteralPath (Join-Path $rootPath $relativePath.Replace("/", "\")) -Algorithm SHA256).Hash
    [void]$canonical.Append($fileHash).Append("  ").Append($relativePath).Append("`n")
  }
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($canonical.ToString())
    return ([BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace("-", "")
  } finally {
    $sha256.Dispose()
  }
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $repositoryRoot "package.json") -Raw | ConvertFrom-Json
$packageLockPath = Join-Path $repositoryRoot "package-lock.json"
$lockVersions = @(& node.exe -e "const fs=require('fs');const lock=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));console.log(lock.version);console.log(lock.packages[''].version);" $packageLockPath)
if ($LASTEXITCODE -ne 0 -or $lockVersions.Count -ne 2 -or $package.version -ne "0.2.4" -or $lockVersions[0] -ne $package.version -or $lockVersions[1] -ne $package.version) {
  throw "package.json and package-lock.json must identify release 0.2.4."
}
$expectedNpmVersion = ([string]$package.packageManager).Replace("npm@", "")
$actualNpmVersion = (& npm.cmd --version).Trim()
if ($LASTEXITCODE -ne 0 -or $expectedNpmVersion -ne "11.16.0" -or $actualNpmVersion -ne $expectedNpmVersion) {
  throw "The private release requires npm $expectedNpmVersion."
}

$sourceCommit = (& git.exe -C $repositoryRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[0-9a-f]{40}$') {
  throw "The source commit could not be identified."
}
$gitStatus = (& git.exe -C $repositoryRoot status --porcelain=v1 --untracked-files=all) -join "`n"
if ($LASTEXITCODE -ne 0) {
  throw "The Git worktree state could not be read."
}
$sourceState = if ($AllowDirty) { "development" } else { "release" }
if (-not $AllowDirty) {
  if (-not [string]::IsNullOrEmpty($gitStatus)) {
    throw "A private release requires a clean Git worktree."
  }
  $tagName = "v$($package.version)"
  $tagType = (& git.exe -C $repositoryRoot cat-file -t $tagName).Trim()
  if ($LASTEXITCODE -ne 0 -or $tagType -ne "tag") {
    throw "A private release requires the annotated tag $tagName."
  }
  $tagCommit = (& git.exe -C $repositoryRoot rev-parse "$tagName^{commit}").Trim()
  if ($LASTEXITCODE -ne 0 -or $tagCommit -ne $sourceCommit) {
    throw "The annotated release tag does not identify HEAD."
  }
}

& npm.cmd ci --strict-allow-scripts=true --dangerously-allow-all-scripts=false --ignore-scripts=false
if ($LASTEXITCODE -ne 0) {
  throw "Dependency installation failed with exit code $LASTEXITCODE."
}

& npm.cmd run verify
if ($LASTEXITCODE -ne 0) {
  throw "Verification failed with exit code $LASTEXITCODE."
}

$releaseDirectory = Join-Path $repositoryRoot "release"
if (Test-Path -LiteralPath $releaseDirectory) {
  Remove-Item -LiteralPath $releaseDirectory -Recurse -Force
}
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
if (-not $AllowDirty) {
  $postBuildCommit = (& git.exe -C $repositoryRoot rev-parse HEAD).Trim()
  $postBuildStatus = (& git.exe -C $repositoryRoot status --porcelain=v1 --untracked-files=all) -join "`n"
  if ($LASTEXITCODE -ne 0 -or $postBuildCommit -ne $sourceCommit -or -not [string]::IsNullOrEmpty($postBuildStatus)) {
    throw "The release source changed during dependency installation or build."
  }
}

$setup = Join-Path $releaseDirectory "GoLiveBypassSafeSetup.exe"
$unpackedManager = Join-Path $releaseDirectory "win-unpacked\GoLiveBypass Safe.exe"
$trustScript = Join-Path $releaseDirectory "Trust-GoLiveBypassSafe.ps1"
$sacHelper = Join-Path $releaseDirectory "Sac-GoLiveBypassSafe.ps1"
$batchInstaller = Join-Path $releaseDirectory "Install-GoLiveBypassSafe.bat"
$releaseCertificate = Join-Path $releaseDirectory "GoLiveBypassSafe.cer"
$sourceProvenance = Join-Path $releaseDirectory "SOURCE.txt"
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "sac-supervisor.ps1") -Destination $sacHelper -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "Install-GoLiveBypassSafe.bat") -Destination $batchInstaller -Force
Copy-Item -LiteralPath $certificatePath -Destination $releaseCertificate -Force

$helperSignature = Set-AuthenticodeSignature `
  -LiteralPath $sacHelper `
  -Certificate $signingCertificate `
  -HashAlgorithm SHA256 `
  -IncludeChain All `
  -TimestampServer "http://timestamp.digicert.com"
if ($helperSignature.Status -ne "Valid") {
  throw "The SAC helper signature is not valid: $($helperSignature.StatusMessage)"
}

$controller = Get-Content -LiteralPath (Join-Path $PSScriptRoot "trust-and-install.ps1") -Raw
$controller = $controller.Replace("__RELEASE_VERSION__", [string]$package.version)
$controller = $controller.Replace("__SOURCE_COMMIT__", $sourceCommit)
$controller = $controller.Replace("__SOURCE_STATE__", $sourceState)
$controller = $controller.Replace("__HELPER_SHA256__", (Get-FileHash -LiteralPath $sacHelper -Algorithm SHA256).Hash)
$controller = $controller.Replace("__SETUP_SHA256__", (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash)
$controller = $controller.Replace("__MANAGER_TREE_SHA256__", (Get-FileTreeSha256 (Split-Path -Parent $unpackedManager)))
if ($controller.Contains("__RELEASE_VERSION__") -or $controller.Contains("__SOURCE_COMMIT__") -or $controller.Contains("__SOURCE_STATE__") -or $controller.Contains("__HELPER_SHA256__") -or $controller.Contains("__SETUP_SHA256__") -or $controller.Contains("__MANAGER_TREE_SHA256__")) {
  throw "The release controller still contains unresolved build placeholders."
}
[IO.File]::WriteAllText($trustScript, $controller, [Text.Encoding]::ASCII)
$controllerSignature = Set-AuthenticodeSignature `
  -LiteralPath $trustScript `
  -Certificate $signingCertificate `
  -HashAlgorithm SHA256 `
  -IncludeChain All `
  -TimestampServer "http://timestamp.digicert.com"
if ($controllerSignature.Status -ne "Valid") {
  throw "The trust controller signature is not valid: $($controllerSignature.StatusMessage)"
}

foreach ($artifact in @($setup, $unpackedManager, $trustScript, $sacHelper)) {
  $signature = Get-AuthenticodeSignature -LiteralPath $artifact
  if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Thumbprint -ne $publicCertificate.Thumbprint) {
    throw "Release artifact '$artifact' does not have the expected valid signature."
  }
}

$manifest = Get-Content -LiteralPath (Join-Path $repositoryRoot "vendor\tor-manifest.json") -Raw | ConvertFrom-Json
$packagedRuntime = Join-Path $releaseDirectory "win-unpacked\resources\runtime"
foreach ($name in @("gateway-relay.cjs", "payload.cjs", "proxy.pac", "runtime-safety.cjs")) {
  $sourceFile = Join-Path $repositoryRoot "runtime\$name"
  $packagedFile = Join-Path $packagedRuntime $name
  if ((Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $packagedFile -Algorithm SHA256).Hash) {
    throw "The packaged runtime file '$name' no longer matches its source."
  }
}
$sourceManifest = Join-Path $repositoryRoot "vendor\tor-manifest.json"
$packagedManifest = Join-Path $packagedRuntime "tor-manifest.json"
if ((Get-FileHash -LiteralPath $sourceManifest -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $packagedManifest -Algorithm SHA256).Hash) {
  throw "The packaged Tor manifest no longer matches its source."
}
$packagedTorRoot = Join-Path $packagedRuntime "tor"
$actualTorFiles = @(Get-ChildItem -LiteralPath $packagedTorRoot -Recurse -File | ForEach-Object {
  if (($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "The packaged Tor runtime contains a reparse point."
  }
  $_.FullName.Substring($packagedTorRoot.Length + 1).Replace("\", "/")
})
$listedTorFiles = @($manifest.files.PSObject.Properties.Name)
if (@(Compare-Object $listedTorFiles $actualTorFiles).Count -ne 0) {
  throw "The packaged Tor file tree no longer matches the manifest."
}
foreach ($property in $manifest.files.PSObject.Properties) {
  $packagedFile = Join-Path $packagedTorRoot $property.Name.Replace("/", "\")
  if ((Get-FileHash -LiteralPath $packagedFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $property.Value) {
    throw "The packaged Tor file '$($property.Name)' no longer matches the manifest."
  }
}

if ((Get-Item -LiteralPath $unpackedManager).VersionInfo.FileVersion -ne [string]$package.version) {
  throw "The unpacked manager version does not match package.json."
}
$fuseTool = Join-Path $repositoryRoot "node_modules\@electron\fuses\dist\bin.js"
$fuseOutput = (& node.exe $fuseTool read --app $unpackedManager 2>&1) -join "`n"
if ($LASTEXITCODE -ne 0) {
  throw "Electron fuse inspection failed."
}
foreach ($expectedFuse in @(
  "RunAsNode is Disabled",
  "EnableCookieEncryption is Enabled",
  "EnableNodeOptionsEnvironmentVariable is Disabled",
  "EnableNodeCliInspectArguments is Disabled",
  "EnableEmbeddedAsarIntegrityValidation is Enabled",
  "OnlyLoadAppFromAsar is Enabled",
  "LoadBrowserProcessSpecificV8Snapshot is Disabled",
  "GrantFileProtocolExtraPrivileges is Enabled"
)) {
  if (-not $fuseOutput.Contains($expectedFuse)) {
    throw "Unexpected Electron fuse state: $expectedFuse."
  }
}

[IO.File]::WriteAllLines($sourceProvenance, @(
  "version=$($package.version)",
  "commit=$sourceCommit",
  "state=$sourceState"
), [Text.Encoding]::ASCII)
$assets = @($setup, $trustScript, $sacHelper, $batchInstaller, $releaseCertificate, $sourceProvenance)
$checksums = $assets | ForEach-Object {
  "{0}  {1}" -f (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash, (Split-Path -Leaf $_)
}
$checksumPath = Join-Path $releaseDirectory "SHA256SUMS.txt"
[System.IO.File]::WriteAllLines($checksumPath, $checksums, [System.Text.Encoding]::ASCII)
Remove-Item -LiteralPath (Join-Path $releaseDirectory "win-unpacked") -Recurse -Force
foreach ($generated in @(".cache", "builder-debug.yml", "builder-effective-config.yaml", "latest.yml", "GoLiveBypassSafeSetup.exe.blockmap")) {
  Remove-Item -LiteralPath (Join-Path $releaseDirectory $generated) -Recurse -Force -ErrorAction SilentlyContinue
}
$bundleName = "GoLiveBypassSafe-v$($package.version).zip"
$bundlePath = & (Join-Path $PSScriptRoot "create-release-bundle.ps1") -ReleaseDirectory $releaseDirectory -Version ([string]$package.version)
if ($bundlePath -ne (Join-Path $releaseDirectory $bundleName)) {
  throw "The release bundle was not created at the expected path."
}

foreach ($bundledFile in $assets + @($checksumPath)) {
  Remove-Item -LiteralPath $bundledFile -Force
}
$expectedNames = @($bundleName)
$actualNames = @(Get-ChildItem -LiteralPath $releaseDirectory -Force | ForEach-Object { $_.Name })
if (@(Compare-Object $expectedNames $actualNames).Count -ne 0) {
  throw "The release directory contains an unexpected artifact set."
}
if (-not $AllowDirty) {
  $finalCommit = (& git.exe -C $repositoryRoot rev-parse HEAD).Trim()
  $finalStatus = (& git.exe -C $repositoryRoot status --porcelain=v1 --untracked-files=all) -join "`n"
  if ($LASTEXITCODE -ne 0 -or $finalCommit -ne $sourceCommit -or -not [string]::IsNullOrEmpty($finalStatus)) {
    throw "The release source changed while artifacts were being verified and signed."
  }
}
"Private $sourceState build $($package.version) from $sourceCommit verified with certificate $($publicCertificate.Thumbprint)."
