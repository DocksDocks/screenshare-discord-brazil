param(
  [Parameter(Mandatory = $true)]
  [string]$ReleaseDirectory,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$Version
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$releaseRoot = (Resolve-Path -LiteralPath $ReleaseDirectory).Path
$inputNames = @(
  "GoLiveBypassSafeSetup.exe",
  "Install-GoLiveBypassSafe.bat",
  "Install-GoLiveBypassSafe.ps1",
  "SHA256SUMS.txt",
  "SOURCE.txt"
)
$inputPaths = foreach ($name in $inputNames) {
  $file = Get-Item -LiteralPath (Join-Path $releaseRoot $name) -Force
  if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "The release bundle input '$name' is not a regular file."
  }
  $file.FullName
}

$bundlePath = Join-Path $releaseRoot "GoLiveBypassSafe-v$Version.zip"
$bundleTimestamp = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
Add-Type -AssemblyName System.IO.Compression
$bundleStream = [IO.File]::Open($bundlePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  $bundleArchive = [IO.Compression.ZipArchive]::new($bundleStream, [IO.Compression.ZipArchiveMode]::Create, $true)
  try {
    foreach ($file in $inputPaths) {
      $entry = $bundleArchive.CreateEntry((Split-Path -Leaf $file), [IO.Compression.CompressionLevel]::NoCompression)
      $entry.LastWriteTime = $bundleTimestamp
      $sourceStream = [IO.File]::OpenRead($file)
      try {
        $entryStream = $entry.Open()
        try {
          $sourceStream.CopyTo($entryStream)
        } finally {
          $entryStream.Dispose()
        }
      } finally {
        $sourceStream.Dispose()
      }
    }
  } finally {
    $bundleArchive.Dispose()
  }
} finally {
  $bundleStream.Dispose()
}

$bundleStream = [IO.File]::OpenRead($bundlePath)
try {
  $bundleArchive = [IO.Compression.ZipArchive]::new($bundleStream, [IO.Compression.ZipArchiveMode]::Read, $true)
  try {
    $actualEntries = @($bundleArchive.Entries | ForEach-Object { $_.FullName })
    if (($actualEntries -join "`n") -cne ($inputNames -join "`n")) {
      throw "The release bundle contains an unexpected entry sequence."
    }
    foreach ($file in $inputPaths) {
      $entry = $bundleArchive.GetEntry((Split-Path -Leaf $file))
      if ($null -eq $entry -or $entry.Length -ne (Get-Item -LiteralPath $file).Length) {
        throw "The release bundle entry for '$file' has an unexpected size."
      }
      $entryStream = $entry.Open()
      $sha256 = [Security.Cryptography.SHA256]::Create()
      try {
        $entryHash = ([BitConverter]::ToString($sha256.ComputeHash($entryStream))).Replace("-", "")
      } finally {
        $sha256.Dispose()
        $entryStream.Dispose()
      }
      if ($entryHash -cne (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash) {
        throw "The release bundle entry for '$file' does not match its source."
      }
    }
  } finally {
    $bundleArchive.Dispose()
  }
} finally {
  $bundleStream.Dispose()
}

$bundlePath
