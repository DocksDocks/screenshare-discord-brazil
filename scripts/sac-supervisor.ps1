param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 65535)]
  [int]$Port,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9A-F]{64}$')]
  [string]$Token,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^(?:missing|0|[1-9][0-9]{0,9})$')]
  [ValidateScript({
    $_ -eq "missing" -or
      [uint64]::Parse($_, [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture) -le [uint32]::MaxValue
  })]
  [string]$ExpectedState,

  [Parameter(Mandatory = $true)]
  [ValidateRange(60, 600)]
  [int]$TimeoutSeconds
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$expectedThumbprint = "4960FAD2932D56589F1DADFF3CBEE143FAA9EB35"
$sacRegistrySubKey = "SYSTEM\CurrentControlSet\Control\CI\Policy"
$sacRegistryValue = "VerifiedAndReputablePolicyState"
$ciTool = Join-Path ([Environment]::SystemDirectory) "CiTool.exe"
$client = $null
$stream = $null
$reader = $null
$writer = $null
$selfLock = $null
$cleanupMutex = $null
$cleanupMutexOwned = $false
$changed = $false
$priorState = $null
$committed = $false

function Assert-RegularFileWithoutReparsePoints([string]$Path) {
  $fullPath = [IO.Path]::GetFullPath($Path)
  $current = $fullPath
  while ($true) {
    $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "reparse_point"
    }
    $parent = [IO.Directory]::GetParent($current)
    if ($null -eq $parent) {
      break
    }
    $current = $parent.FullName
  }
  if ((Get-Item -LiteralPath $fullPath -Force).PSIsContainer) {
    throw "not_regular_file"
  }
  return $fullPath
}

function Get-SacState {
  $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($sacRegistrySubKey, $false)
  if ($null -eq $key) {
    throw "sac_registry_key_missing"
  }
  try {
    if (-not (@($key.GetValueNames()) -ccontains $sacRegistryValue)) {
      return "missing"
    }
    if ($key.GetValueKind($sacRegistryValue) -ne [Microsoft.Win32.RegistryValueKind]::DWord) {
      throw "sac_registry_type_invalid"
    }
    $rawValue = [int32]$key.GetValue($sacRegistryValue, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $value = [BitConverter]::ToUInt32([BitConverter]::GetBytes($rawValue), 0)
    return $value.ToString([Globalization.CultureInfo]::InvariantCulture)
  } finally {
    $key.Dispose()
  }
}

function Set-SacState([int]$Value) {
  $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($sacRegistrySubKey, $true)
  if ($null -eq $key) {
    throw "sac_registry_key_missing"
  }
  try {
    $key.SetValue($sacRegistryValue, $Value, [Microsoft.Win32.RegistryValueKind]::DWord)
  } finally {
    $key.Dispose()
  }
}

function Get-EffectiveSacState {
  $json = (& $ciTool --list-policies --json 2>&1) -join "`n"
  if ($LASTEXITCODE -ne 0) {
    throw "citool_list_exit_$LASTEXITCODE"
  }
  try {
    $policies = @((ConvertFrom-Json $json).Policies)
  } catch {
    throw "citool_list_invalid"
  }
  $enforcedNames = @($policies | Where-Object { [string]$_.IsEnforced -ieq "True" } | ForEach-Object { [string]$_.FriendlyName })
  $enforce = $enforcedNames -ccontains "VerifiedAndReputableDesktop"
  $evaluation = $enforcedNames -ccontains "VerifiedAndReputableDesktopEvaluation"
  if ($enforce -and $evaluation) {
    throw "sac_effective_state_conflict"
  }
  if ($enforce) {
    return "1"
  }
  if ($evaluation) {
    return "2"
  }
  return "0"
}

function Invoke-CiRefresh {
  & $ciTool --refresh
  if ($LASTEXITCODE -ne 0) {
    throw "citool_exit_$LASTEXITCODE"
  }
}

function Read-ProtocolLine([IO.StreamReader]$Reader) {
  $line = New-Object Text.StringBuilder
  while ($line.Length -le 256) {
    $character = $Reader.Read()
    if ($character -eq -1) {
      if ($line.Length -eq 0) {
        return $null
      }
      throw "protocol_eof"
    }
    if ($character -eq 10) {
      return $line.ToString()
    }
    if ($character -eq 13) {
      throw "protocol_carriage_return"
    }
    [void]$line.Append([char]$character)
  }
  throw "protocol_line_too_long"
}

function Enter-CleanupMutex {
  if ($null -eq $script:cleanupMutex) {
    throw "cleanup_mutex_missing"
  }
  if ($script:cleanupMutexOwned) {
    return
  }
  try {
    [void]$script:cleanupMutex.WaitOne()
  } catch [Threading.AbandonedMutexException] {
  }
  $script:cleanupMutexOwned = $true
}

function Exit-CleanupMutex {
  if ($script:cleanupMutexOwned) {
    $script:cleanupMutex.ReleaseMutex()
    $script:cleanupMutexOwned = $false
  }
}

function Close-HelperResources {
  foreach ($resource in @($writer, $reader, $stream)) {
    if ($null -ne $resource) {
      try {
        $resource.Dispose()
      } catch {
      }
    }
  }
  if ($null -ne $client) {
    try {
      $client.Close()
    } catch {
    }
  }
  if ($null -ne $selfLock) {
    try {
      $selfLock.Dispose()
    } catch {
    }
  }
  if ($null -ne $cleanupMutex) {
    try {
      Exit-CleanupMutex
    } catch {
    }
    $cleanupMutex.Dispose()
  }
}

try {
  $selfPath = Assert-RegularFileWithoutReparsePoints $PSCommandPath
  $selfLock = [IO.File]::Open($selfPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $signature = Get-AuthenticodeSignature -LiteralPath $selfPath
  if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or
      $null -eq $signature.SignerCertificate -or
      $signature.SignerCertificate.Thumbprint -cne $expectedThumbprint) {
    throw "signature_mismatch"
  }

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "helper_not_elevated"
  }

  if ($ExpectedState -eq "1") {
    $cleanupMutex = [Threading.Mutex]::new($false, "Local\GoLiveBypassSafeCleanup-$Token")
  }

  $client = New-Object Net.Sockets.TcpClient([Net.Sockets.AddressFamily]::InterNetwork)
  $client.Connect([Net.IPAddress]::Loopback, $Port)
  $stream = $client.GetStream()
  $stream.ReadTimeout = $TimeoutSeconds * 1000
  $stream.WriteTimeout = 10000
  $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::ASCII, $false, 256, $true)
  $writer = New-Object IO.StreamWriter($stream, [Text.Encoding]::ASCII, 256, $true)
  $writer.NewLine = "`n"
  $writer.AutoFlush = $true
  $writer.WriteLine("HELLO $Token")
  if ((Read-ProtocolLine $reader) -cne "AUTH $Token") {
    throw "controller_authentication_failed"
  }

  $priorState = Get-SacState
  if ($priorState -cne $ExpectedState) {
    throw "sac_state_changed"
  }
  $expectedEffectiveState = if ($priorState -eq "missing") { "0" } else { $priorState }
  if ((Get-EffectiveSacState) -cne $expectedEffectiveState) {
    throw "sac_effective_state_changed"
  }
  if ($priorState -eq "1") {
    Set-SacState 0
    $changed = $true
    Invoke-CiRefresh
    if ((Get-SacState) -cne "0" -or (Get-EffectiveSacState) -cne "0") {
      throw "sac_disable_unconfirmed"
    }
  }

  $writer.WriteLine("READY $Token $priorState")
  $command = Read-ProtocolLine $reader
  if ($command -ceq "ABORT $Token") {
    throw "controller_aborted"
  }
  if ($command -cne "COMMIT $Token") {
    throw "commit_invalid"
  }
  if ($changed) {
    $successRestoreFailed = $false
    Enter-CleanupMutex
    try {
      try {
        Set-SacState 1
        Invoke-CiRefresh
        if ((Get-SacState) -cne $priorState -or (Get-EffectiveSacState) -cne "1") {
          throw "sac_success_restore_unconfirmed"
        }
      } catch {
        $successRestoreFailed = $true
        try {
          Set-SacState 0
          Invoke-CiRefresh
          if ((Get-SacState) -cne "0" -or (Get-EffectiveSacState) -cne "0") {
            throw "sac_commit_rollback_state_unconfirmed"
          }
        } catch {
          throw "sac_success_restore_unconfirmed"
        }
      }
    } finally {
      Exit-CleanupMutex
    }
    if ($successRestoreFailed) {
      $writer.WriteLine("ROLLBACK_READY $Token")
      if ((Read-ProtocolLine $reader) -cne "ABORT $Token") {
        throw "commit_rollback_command_invalid"
      }
      throw "sac_success_restore_failed"
    }
  } else {
    Invoke-CiRefresh
  }
  $successfulEffectiveState = if ($priorState -eq "missing") { "0" } else { $priorState }
  if ((Get-SacState) -cne $priorState -or (Get-EffectiveSacState) -cne $successfulEffectiveState) {
    throw "sac_success_restore_unconfirmed"
  }
  $committed = $true
  try {
    $writer.WriteLine("COMMITTED $Token")
  } catch {
  }
} catch {
  $rollbackConfirmed = $true
  if ($null -ne $priorState -and -not $committed) {
    try {
      if ($changed) {
        Enter-CleanupMutex
        try {
          Set-SacState 1
          Invoke-CiRefresh
        } finally {
          Exit-CleanupMutex
        }
      } else {
        Invoke-CiRefresh
      }
      $rollbackEffectiveState = if ($priorState -eq "missing") { "0" } else { $priorState }
      if ((Get-SacState) -cne $priorState -or (Get-EffectiveSacState) -cne $rollbackEffectiveState) {
        $rollbackConfirmed = $false
      }
    } catch {
      $rollbackConfirmed = $false
    }
  }
  if ($rollbackConfirmed -and $null -ne $writer) {
    try {
      $writer.WriteLine("ROLLED_BACK $Token")
    } catch {
    }
  }
  Close-HelperResources
  if ($rollbackConfirmed) {
    exit 1
  }
  exit 2
}

Close-HelperResources
exit 0
