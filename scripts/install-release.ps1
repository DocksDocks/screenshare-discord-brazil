Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$releaseVersion = "__RELEASE_VERSION__"
$sourceCommit = "__SOURCE_COMMIT__"
$sourceState = "__SOURCE_STATE__"
$expectedSetupSha256 = "__SETUP_SHA256__"
$expectedManagerTreeSha256 = "__MANAGER_TREE_SHA256__"
$installRegistrySubKey = "Software\2bab6ef2-82b6-538a-983f-87f4c93796a6"
$uninstallRegistrySubKey = "Software\Microsoft\Windows\CurrentVersion\Uninstall\2bab6ef2-82b6-538a-983f-87f4c93796a6"
$sacRegistrySubKey = "SYSTEM\CurrentControlSet\Control\CI\Policy"
$sacRegistryValue = "VerifiedAndReputablePolicyState"
$applicationTimeoutSeconds = 180
$cleanupTimeoutSeconds = 60

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

function Get-LockedSha256([IO.FileStream]$Stream) {
  $position = $Stream.Position
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $Stream.Position = 0
    return ([BitConverter]::ToString($sha256.ComputeHash($Stream))).Replace("-", "")
  } finally {
    $Stream.Position = $position
    $sha256.Dispose()
  }
}

function Get-RegisteredManagerPaths {
  $result = $null
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
    $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
    $key = $null
    try {
      $key = $baseKey.OpenSubKey($installRegistrySubKey, $false)
      if ($null -eq $key) {
        continue
      }
      if (-not (@($key.GetValueNames()) -ccontains "InstallLocation") -or
          $key.GetValueKind("InstallLocation") -ne [Microsoft.Win32.RegistryValueKind]::String) {
        throw "manager_registration_invalid"
      }
      $installRoot = [string]$key.GetValue("InstallLocation", $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if ([string]::IsNullOrWhiteSpace($installRoot) -or $installRoot -notmatch '^[A-Za-z]:\\') {
        throw "manager_registration_invalid"
      }
      $candidate = [pscustomobject]@{
        ManagerPath = [IO.Path]::GetFullPath((Join-Path $installRoot "GoLiveBypass Safe.exe"))
        UninstallerPath = [IO.Path]::GetFullPath((Join-Path $installRoot "Uninstall GoLiveBypass Safe.exe"))
      }
      if ($null -eq $result) {
        $result = $candidate
      } elseif (-not [StringComparer]::OrdinalIgnoreCase.Equals($result.ManagerPath, $candidate.ManagerPath) -or
                -not [StringComparer]::OrdinalIgnoreCase.Equals($result.UninstallerPath, $candidate.UninstallerPath)) {
        throw "manager_registration_ambiguous"
      }
    } finally {
      if ($null -ne $key) {
        $key.Dispose()
      }
      $baseKey.Dispose()
    }
  }
  return $result
}

function Test-UninstallRegistration([string]$ExpectedUninstallerPath) {
  $found = $false
  $expectedUninstall = '"{0}" /currentuser' -f $ExpectedUninstallerPath
  $expectedQuietUninstall = '"{0}" /currentuser /S' -f $ExpectedUninstallerPath
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
    $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
    $key = $null
    try {
      $key = $baseKey.OpenSubKey($uninstallRegistrySubKey, $false)
      if ($null -ne $key) {
        $found = $true
        foreach ($value in @(
          [pscustomobject]@{ Name = "UninstallString"; Expected = $expectedUninstall },
          [pscustomobject]@{ Name = "QuietUninstallString"; Expected = $expectedQuietUninstall }
        )) {
          if (-not (@($key.GetValueNames()) -ccontains $value.Name) -or
              $key.GetValueKind($value.Name) -ne [Microsoft.Win32.RegistryValueKind]::String -or
              -not [StringComparer]::OrdinalIgnoreCase.Equals(
                [string]$key.GetValue($value.Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames),
                $value.Expected
              )) {
            throw "manager_uninstall_registration_invalid"
          }
        }
      }
    } finally {
      if ($null -ne $key) {
        $key.Dispose()
      }
      $baseKey.Dispose()
    }
  }
  return $found
}

function Get-LockedManagerTreeSha256([string]$Root, [string]$UninstallerPath) {
  $rootPath = [IO.Path]::GetFullPath($Root)
  $pending = New-Object Collections.Generic.Queue[string]
  $relativePaths = New-Object Collections.Generic.List[string]
  $newLocks = New-Object Collections.Generic.List[string]
  $pending.Enqueue($rootPath)
  try {
    while ($pending.Count -ne 0) {
      $directory = $pending.Dequeue()
      foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
          throw "manager_tree_reparse_point"
        }
        if ($item.PSIsContainer) {
          $pending.Enqueue($item.FullName)
        } elseif (-not [StringComparer]::OrdinalIgnoreCase.Equals($item.FullName, $UninstallerPath)) {
          $relativePaths.Add($item.FullName.Substring($rootPath.Length + 1).Replace("\", "/"))
        }
      }
    }
    $relativePaths.Sort([StringComparer]::Ordinal)
    $canonical = New-Object Text.StringBuilder
    foreach ($relativePath in $relativePaths) {
      $filePath = [IO.Path]::GetFullPath((Join-Path $rootPath $relativePath.Replace("/", "\")))
      $locks[$filePath] = [IO.File]::Open($filePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
      $newLocks.Add($filePath)
      $script:managerTreeLockPaths.Add($filePath)
      $fileHash = Get-LockedSha256 $locks[$filePath]
      [void]$canonical.Append($fileHash).Append("  ").Append($relativePath).Append("`n")
    }
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
      $bytes = [Text.UTF8Encoding]::new($false).GetBytes($canonical.ToString())
      return ([BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace("-", "")
    } finally {
      $sha256.Dispose()
    }
  } catch {
    foreach ($filePath in $newLocks) {
      $locks[$filePath].Dispose()
      [void]$locks.Remove($filePath)
      [void]$script:managerTreeLockPaths.Remove($filePath)
    }
    throw
  }
}

function Assert-ManagerTreeMatchesLocks([string]$Root, [string]$UninstallerPath) {
  $rootPath = [IO.Path]::GetFullPath($Root)
  $pending = New-Object Collections.Generic.Queue[string]
  $actualPaths = New-Object Collections.Generic.List[string]
  $pending.Enqueue($rootPath)
  while ($pending.Count -ne 0) {
    $directory = $pending.Dequeue()
    foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "manager_tree_reparse_point"
      }
      if ($item.PSIsContainer) {
        $pending.Enqueue($item.FullName)
      } elseif (-not [StringComparer]::OrdinalIgnoreCase.Equals($item.FullName, $UninstallerPath)) {
        $actualPaths.Add($item.FullName)
      }
    }
  }
  $actualPaths.Sort([StringComparer]::OrdinalIgnoreCase)
  $expectedPaths = New-Object Collections.Generic.List[string]
  foreach ($filePath in $managerTreeLockPaths) {
    $expectedPaths.Add($filePath)
  }
  $expectedPaths.Sort([StringComparer]::OrdinalIgnoreCase)
  if (($actualPaths -join "`n") -cne ($expectedPaths -join "`n")) {
    throw "manager_tree_changed"
  }
}

function Get-SacState {
  $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($sacRegistrySubKey, $false)
  if ($null -eq $key) {
    return "missing"
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

function Get-ProcessCreationTime([object]$Candidate) {
  return ([DateTimeOffset]$Candidate.CreationDate).ToUnixTimeMilliseconds()
}

function Add-DescendantProcesses([object[]]$Processes, [hashtable]$KnownProcesses) {
  foreach ($candidate in $Processes) {
    $processId = [int]$candidate.ProcessId
    if ($KnownProcesses.ContainsKey($processId) -and
        $KnownProcesses[$processId] -ne (Get-ProcessCreationTime $candidate)) {
      [void]$KnownProcesses.Remove($processId)
    }
  }
  do {
    $added = $false
    foreach ($candidate in $Processes) {
      $processId = [int]$candidate.ProcessId
      $parentProcessId = [int]$candidate.ParentProcessId
      $creationTime = Get-ProcessCreationTime $candidate
      if (-not $KnownProcesses.ContainsKey($processId) -and
          $KnownProcesses.ContainsKey($parentProcessId) -and
          $creationTime -ge $KnownProcesses[$parentProcessId]) {
        $KnownProcesses[$processId] = $creationTime
        $added = $true
      }
    }
  } while ($added)
}

function Stop-ProcessTree([hashtable]$KnownProcesses) {
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    $current = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CreationDate)
    Add-DescendantProcesses $current $knownProcesses
    $opened = New-Object Collections.Generic.List[Diagnostics.Process]
    foreach ($entry in @($knownProcesses.GetEnumerator() | Sort-Object Value -Descending)) {
      $candidate = $null
      try {
        $candidate = [Diagnostics.Process]::GetProcessById([int]$entry.Key)
        $null = $candidate.Handle
        $creationTime = ([DateTimeOffset]$candidate.StartTime).ToUnixTimeMilliseconds()
        if ($creationTime -ne [long]$entry.Value) {
          $candidate.Dispose()
          [void]$knownProcesses.Remove([int]$entry.Key)
          continue
        }
        $opened.Add($candidate)
      } catch [ArgumentException] {
        if ($null -ne $candidate) {
          $candidate.Dispose()
        }
        [void]$knownProcesses.Remove([int]$entry.Key)
      } catch [InvalidOperationException] {
        if ($null -ne $candidate -and -not $candidate.HasExited) {
          throw
        }
        if ($null -ne $candidate) {
          $candidate.Dispose()
        }
        [void]$knownProcesses.Remove([int]$entry.Key)
      }
    }
    if ($opened.Count -eq 0) {
      return
    }
    foreach ($candidate in $opened) {
      try {
        if (-not $candidate.HasExited) {
          $candidate.Kill()
        }
        if (-not $candidate.WaitForExit(5000) -and -not $candidate.HasExited) {
          throw "process_tree_termination_timeout"
        }
      } finally {
        $candidate.Dispose()
      }
    }
    Start-Sleep -Milliseconds 250
  }
  throw "process_tree_termination_unconfirmed"
}

function Invoke-BoundedProcess([string]$Path, [string]$Arguments, [int]$TimeoutSeconds) {
  $process = $null
  $identityEstablished = $false
  $knownProcesses = @{}
  try {
    $process = Start-Process -FilePath $Path -ArgumentList $Arguments -PassThru
    $null = $process.Handle
    $knownProcesses[$process.Id] = ([DateTimeOffset]$process.StartTime).ToUnixTimeMilliseconds()
    $identityEstablished = $true
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
      $snapshot = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CreationDate)
      Add-DescendantProcesses $snapshot $knownProcesses
      if (-not $process.HasExited) {
        Start-Sleep -Milliseconds 100
      }
    }
    $finalSnapshot = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CreationDate)
    Add-DescendantProcesses $finalSnapshot $knownProcesses
    if (-not $process.HasExited) {
      throw "process_timeout"
    }
    if ($process.ExitCode -ne 0) {
      throw "process_exit_$($process.ExitCode)"
    }
  } catch {
    $operationFailure = $_
    if ($null -ne $process) {
      if ($identityEstablished) {
        try {
          Stop-ProcessTree $knownProcesses
        } catch {
          $script:processTerminationUnconfirmed = $true
        }
      } else {
        $script:processTerminationUnconfirmed = $true
      }
    }
    throw $operationFailure
  } finally {
    if ($null -ne $process) {
      try {
        $process.Dispose()
      } catch {
      }
    }
  }
}

$locks = @{}
$managerTreeLockPaths = New-Object Collections.Generic.List[string]
$installMutex = $null
$installMutexOwned = $false
$stage = "startup"
$failure = $null
$failureStage = $null
$applicationRollbackConfirmed = $true
$processTerminationUnconfirmed = $false
$setupStarted = $false
$managerStarted = $false
$managerWasPresent = $false
$installedManagerRoot = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "Programs\golivebypass-safe"))
$installedManagerPath = Join-Path $installedManagerRoot "GoLiveBypass Safe.exe"
$installedUninstallerPath = Join-Path $installedManagerRoot "Uninstall GoLiveBypass Safe.exe"
$sacState = $null
$successRecord = $null

try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "elevated_controller"
  }

  $installMutex = [Threading.Mutex]::new($false, "Global\GoLiveBypassSafeReleaseInstall")
  try {
    $installMutexOwned = $installMutex.WaitOne(0)
  } catch [Threading.AbandonedMutexException] {
    $installMutexOwned = $true
  }
  if (-not $installMutexOwned) {
    throw "installation_already_running"
  }

  $controllerPath = Assert-RegularFileWithoutReparsePoints $PSCommandPath
  $setupPath = Assert-RegularFileWithoutReparsePoints (Join-Path $PSScriptRoot "GoLiveBypassSafeSetup.exe")
  foreach ($path in @($controllerPath, $setupPath)) {
    $locks[$path] = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  }

  $stage = "placeholders"
  if ($releaseVersion -eq "__RELEASE_VERSION__" -or
      $sourceCommit -eq "__SOURCE_COMMIT__" -or
      $sourceState -eq "__SOURCE_STATE__" -or
      $expectedSetupSha256 -eq "__SETUP_SHA256__" -or
      $expectedManagerTreeSha256 -eq "__MANAGER_TREE_SHA256__") {
    throw "unresolved_build_placeholder"
  }
  if ($releaseVersion -notmatch '^\d+\.\d+\.\d+$' -or
      $sourceCommit -notmatch '^[0-9a-f]{40}$' -or
      @("release", "development") -cnotcontains $sourceState -or
      $expectedSetupSha256 -notmatch '^[0-9A-F]{64}$' -or
      $expectedManagerTreeSha256 -notmatch '^[0-9A-F]{64}$') {
    throw "invalid_build_value"
  }

  $stage = "artifact_verification"
  if ((Get-LockedSha256 $locks[$setupPath]) -cne $expectedSetupSha256) {
    throw "setup_hash_mismatch"
  }

  $registeredManager = Get-RegisteredManagerPaths
  if ($null -ne $registeredManager -and
      (-not [StringComparer]::OrdinalIgnoreCase.Equals($registeredManager.ManagerPath, $installedManagerPath) -or
       -not [StringComparer]::OrdinalIgnoreCase.Equals($registeredManager.UninstallerPath, $installedUninstallerPath))) {
    throw "manager_registration_mismatch"
  }
  $uninstallRegistrationPresent = Test-UninstallRegistration $installedUninstallerPath
  $managerWasPresent = $null -ne $registeredManager -or (Test-Path -LiteralPath $installedManagerRoot) -or $uninstallRegistrationPresent
  $stage = "sac_check"
  $sacState = Get-SacState
  if (@("missing", "0", "1", "2") -cnotcontains $sacState) {
    throw "unexpected_sac_state"
  }
  if (@("1", "2") -ccontains $sacState) {
    throw "smart_app_control_must_be_off"
  }

  if ($null -eq $registeredManager) {
    if ($managerWasPresent) {
      throw "existing_manager_must_be_removed"
    }
    $stage = "setup"
    $setupStarted = $true
    Invoke-BoundedProcess $setupPath ('/S /D={0}' -f $installedManagerRoot) $applicationTimeoutSeconds
    $stage = "manager_authentication"
    $registeredManager = Get-RegisteredManagerPaths
    if ($null -eq $registeredManager) {
      throw "manager_registration_missing"
    }
  }
  $stage = "manager_authentication"
  if (-not [StringComparer]::OrdinalIgnoreCase.Equals($registeredManager.ManagerPath, $installedManagerPath) -or
      -not [StringComparer]::OrdinalIgnoreCase.Equals($registeredManager.UninstallerPath, $installedUninstallerPath)) {
    throw "manager_registration_mismatch"
  }
  if (-not (Test-UninstallRegistration $installedUninstallerPath)) {
    if (-not $setupStarted) {
      throw "existing_manager_must_be_removed"
    }
    throw "manager_uninstall_registration_missing"
  }
  $installedManagerPath = Assert-RegularFileWithoutReparsePoints $registeredManager.ManagerPath
  $installedUninstallerPath = Assert-RegularFileWithoutReparsePoints $registeredManager.UninstallerPath
  $locks[$installedUninstallerPath] = [IO.File]::Open($installedUninstallerPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $managerTreeSha256 = Get-LockedManagerTreeSha256 $installedManagerRoot $installedUninstallerPath
  if ($managerTreeSha256 -cne $expectedManagerTreeSha256) {
    if (-not $setupStarted) {
      throw "existing_manager_must_be_removed"
    }
    throw "manager_tree_hash_mismatch"
  }

  $stage = "manager"
  Assert-ManagerTreeMatchesLocks $installedManagerRoot $installedUninstallerPath
  $managerStarted = $true
  Invoke-BoundedProcess $installedManagerPath "--install-and-exit" $applicationTimeoutSeconds

  $successRecord = "GOLIVE_AUTOMATION_OK version=$releaseVersion commit=$sourceCommit state=$sourceState"
  if ($sacState -eq "0") {
    $successRecord += " smart_app_control=reenable_manually"
  }
} catch {
  $failure = $_
  $failureStage = $stage
  if ($processTerminationUnconfirmed) {
    $applicationRollbackConfirmed = $false
  } elseif ($managerStarted) {
    try {
      $stage = "application_restore"
      Assert-ManagerTreeMatchesLocks $installedManagerRoot $installedUninstallerPath
      Invoke-BoundedProcess $installedManagerPath "--restore-before-uninstall" $cleanupTimeoutSeconds
    } catch {
      $applicationRollbackConfirmed = $false
    }
  }
} finally {
  foreach ($lock in $locks.Values) {
    try {
      $lock.Dispose()
    } catch {
    }
  }
  if ($null -ne $installMutex) {
    if ($installMutexOwned) {
      $installMutex.ReleaseMutex()
    }
    $installMutex.Dispose()
  }
}

if ($null -eq $failure) {
  [Console]::Out.WriteLine($successRecord)
  exit 0
}
$managerPreserved = ($managerWasPresent -or $setupStarted).ToString().ToLowerInvariant()
if (-not $applicationRollbackConfirmed) {
  [Console]::Error.WriteLine("GOLIVE_AUTOMATION_ROLLBACK_UNCONFIRMED code=2 stage=$failureStage app=false manager_preserved=$managerPreserved reason=$($failure.Exception.Message)")
  exit 2
}
[Console]::Error.WriteLine("GOLIVE_AUTOMATION_ERROR code=1 stage=$failureStage manager_preserved=$managerPreserved reason=$($failure.Exception.Message)")
exit 1
