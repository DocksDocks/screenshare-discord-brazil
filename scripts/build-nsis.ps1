Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Remove-ExactSection([string]$Text, [string]$StartMarker, [string]$EndMarker) {
  $start = $Text.IndexOf($StartMarker, [StringComparison]::Ordinal)
  $end = $Text.IndexOf($EndMarker, $start, [StringComparison]::Ordinal)
  if ($start -lt 0 -or $end -lt 0 -or
      $start -ne $Text.LastIndexOf($StartMarker, [StringComparison]::Ordinal)) {
    throw "The pinned electron-builder utility section could not be isolated exactly once."
  }
  return $Text.Substring(0, $start) + $Text.Substring($end)
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$templatePath = Join-Path $repositoryRoot "node_modules\app-builder-lib\templates\nsis\include\installUtil.nsh"
$builderPath = Join-Path $repositoryRoot "node_modules\.bin\electron-builder.cmd"
$expectedTemplateSha256 = "97BD546B5CD2AAF16B77BC9E2BE8A18962DD74AB5C4D23B35B163CA89BF4DD2A"
$originalBytes = [IO.File]::ReadAllBytes($templatePath)
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
  $actualTemplateSha256 = ([BitConverter]::ToString($sha256.ComputeHash($originalBytes))).Replace("-", "")
} finally {
  $sha256.Dispose()
}
if ($actualTemplateSha256 -cne $expectedTemplateSha256) {
  throw "The pinned electron-builder install utility no longer matches its audited hash."
}
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$original = $utf8.GetString($originalBytes)
$patched = Remove-ExactSection $original "Function GetInQuotes`n" "Function GetFileParent`n"
$patched = Remove-ExactSection $patched "Function GetFileParent`n" "Var /GLOBAL isTryToKeepShortcuts`n"
$functionStartMarker = "Function uninstallOldVersion`n"
$functionEndMarker = "`nFunctionEnd`n`n!macro uninstallOldVersion ROOT_KEY"
$functionStart = $patched.IndexOf($functionStartMarker, [StringComparison]::Ordinal)
$functionEnd = $patched.IndexOf($functionEndMarker, $functionStart, [StringComparison]::Ordinal)
if ($functionStart -lt 0 -or $functionEnd -lt 0 -or
    $functionStart -ne $patched.LastIndexOf($functionStartMarker, [StringComparison]::Ordinal) -or
    $functionEnd -ne $patched.LastIndexOf($functionEndMarker, [StringComparison]::Ordinal)) {
  throw "The pinned electron-builder uninstall function could not be isolated exactly once."
}

$functionEnd += "`nFunctionEnd".Length
$safeFunction = @'
Function uninstallOldVersion
  Var /GLOBAL rootKey

  ClearErrors
  Exch $rootKey
  StrCpy $R0 0
FunctionEnd
'@
$safeFunction = $safeFunction.Replace("`r`n", "`n").TrimEnd("`r", "`n")
$patched = $patched.Substring(0, $functionStart) + $safeFunction + $patched.Substring($functionEnd)
try {
  [IO.File]::WriteAllBytes($templatePath, $utf8.GetBytes($patched))
  & $builderPath --win --x64 --publish never
  if ($LASTEXITCODE -ne 0) {
    throw "electron-builder failed with exit code $LASTEXITCODE."
  }
} finally {
  [IO.File]::WriteAllBytes($templatePath, $originalBytes)
}
