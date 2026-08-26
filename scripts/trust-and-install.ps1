param(
  [switch]$RemoveTrust
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$expectedThumbprint = "4960FAD2932D56589F1DADFF3CBEE143FAA9EB35"
$expectedCertificateSha256 = "D5D0C0EE02D56A38910CF223A55EDFAA28223AFF8AABF54DCD322F0DB6EB078A"
$releaseVersion = "__RELEASE_VERSION__"
$sourceCommit = "__SOURCE_COMMIT__"
$sourceState = "__SOURCE_STATE__"
$expectedHelperSha256 = "__HELPER_SHA256__"
$expectedSetupSha256 = "__SETUP_SHA256__"
$expectedManagerTreeSha256 = "__MANAGER_TREE_SHA256__"
$installRegistrySubKey = "Software\2bab6ef2-82b6-538a-983f-87f4c93796a6"
$sacRegistrySubKey = "SYSTEM\CurrentControlSet\Control\CI\Policy"
$sacRegistryValue = "VerifiedAndReputablePolicyState"
$helperTimeoutSeconds = 600
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

function Assert-ExpectedSignature([string]$Path) {
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or
      $null -eq $signature.SignerCertificate -or
      $signature.SignerCertificate.Thumbprint -cne $expectedThumbprint) {
    throw "signature_mismatch"
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

function Invoke-BoundedProcess([string]$Path, [string]$Arguments, [int]$TimeoutSeconds, [IO.FileStream]$LaunchLock = $null) {
  try {
    $process = Start-Process -FilePath $Path -ArgumentList $Arguments -PassThru
  } finally {
    if ($null -ne $LaunchLock) {
      $LaunchLock.Dispose()
    }
  }
  $knownProcesses = @{
    $process.Id = ([DateTimeOffset]$process.StartTime).ToUnixTimeMilliseconds()
  }
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
    Stop-ProcessTree $knownProcesses
    throw "process_timeout"
  }
  if ($process.ExitCode -ne 0) {
    Stop-ProcessTree $knownProcesses
    throw "process_exit_$($process.ExitCode)"
  }
}

function Remove-AddedTrust([string[]]$Stores) {
  $confirmed = $true
  foreach ($store in $Stores) {
    $entry = Join-Path $store $expectedThumbprint
    try {
      if (Test-Path -LiteralPath $entry) {
        Remove-Item -LiteralPath $entry -Force
      }
      if (Test-Path -LiteralPath $entry) {
        $confirmed = $false
      }
    } catch {
      $confirmed = $false
    }
  }
  return $confirmed
}

$locks = @{}
$managerTreeLockPaths = New-Object Collections.Generic.List[string]
$addedStores = New-Object Collections.Generic.List[string]
$listener = $null
$client = $null
$stream = $null
$reader = $null
$writer = $null
$helperProcess = $null
$helperCreationTime = $null
$cleanupMutex = $null
$cleanupMutexOwned = $false
$priorSacState = $null
$stage = "startup"
$successRecord = $null
$failure = $null
$failureStage = $null
$trustRemovalUnconfirmed = $false
$applicationRollbackConfirmed = $true
$applicationRollbackSafe = $true
$sacRollbackAcknowledged = $false
$helperCouldChangeSac = $false
$setupStarted = $false
$managerStarted = $false
$managerInitiallyInstalled = $false
$managerRootInitiallyExisted = $false
$installedManagerPath = $null
$installedUninstallerPath = $null

try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "elevated_controller"
  }

  $controllerPath = Assert-RegularFileWithoutReparsePoints $PSCommandPath
  $certificatePath = Assert-RegularFileWithoutReparsePoints (Join-Path $PSScriptRoot "GoLiveBypassSafe.cer")
  $pathsToLock = @($controllerPath, $certificatePath)
  if (-not $RemoveTrust) {
    $helperPath = Assert-RegularFileWithoutReparsePoints (Join-Path $PSScriptRoot "Sac-GoLiveBypassSafe.ps1")
    $setupPath = Assert-RegularFileWithoutReparsePoints (Join-Path $PSScriptRoot "GoLiveBypassSafeSetup.exe")
    $pathsToLock += @($helperPath, $setupPath)
  }
  foreach ($path in $pathsToLock) {
    $locks[$path] = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  }

  $stage = "certificate"
  if ((Get-LockedSha256 $locks[$certificatePath]) -cne $expectedCertificateSha256) {
    throw "certificate_hash_mismatch"
  }
  $certificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2($certificatePath)
  if ($certificate.Thumbprint -cne $expectedThumbprint) {
    throw "certificate_thumbprint_mismatch"
  }
  if ($certificate.PublicKey.Oid.Value -cne "1.2.840.113549.1.1.1") {
    throw "certificate_not_rsa"
  }
  $hasCodeSigningEku = $false
  foreach ($extension in $certificate.Extensions) {
    if ($extension.Oid.Value -eq "2.5.29.37") {
      $ekuExtension = [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]$extension
      foreach ($usage in $ekuExtension.EnhancedKeyUsages) {
        if ($usage.Value -eq "1.3.6.1.5.5.7.3.3") {
          $hasCodeSigningEku = $true
        }
      }
    }
  }
  if (-not $hasCodeSigningEku) {
    throw "certificate_eku_mismatch"
  }

  $stores = @("Cert:\CurrentUser\Root", "Cert:\CurrentUser\TrustedPublisher")
  if ($RemoveTrust) {
    $stage = "remove_trust_authentication"
    Assert-ExpectedSignature $controllerPath
    foreach ($store in $stores) {
      $entry = Join-Path $store $expectedThumbprint
      if (Test-Path -LiteralPath $entry) {
        Remove-Item -LiteralPath $entry -Force
      }
      if (Test-Path -LiteralPath $entry) {
        $trustRemovalUnconfirmed = $true
      }
    }
    if ($trustRemovalUnconfirmed) {
      throw "remove_trust_unconfirmed"
    }
    $successRecord = "GOLIVE_AUTOMATION_OK mode=remove_trust"
  } else {
    $stage = "placeholders"
    if ($releaseVersion -eq "__RELEASE_VERSION__" -or
        $sourceCommit -eq "__SOURCE_COMMIT__" -or
        $sourceState -eq "__SOURCE_STATE__" -or
        $expectedHelperSha256 -eq "__HELPER_SHA256__" -or
        $expectedSetupSha256 -eq "__SETUP_SHA256__" -or
        $expectedManagerTreeSha256 -eq "__MANAGER_TREE_SHA256__") {
      throw "unresolved_build_placeholder"
    }
    if ($releaseVersion -notmatch '^\d+\.\d+\.\d+$' -or
        $sourceCommit -notmatch '^[0-9a-f]{40}$' -or
        @("release", "development") -cnotcontains $sourceState -or
        $expectedHelperSha256 -notmatch '^[0-9A-F]{64}$' -or
        $expectedSetupSha256 -notmatch '^[0-9A-F]{64}$' -or
        $expectedManagerTreeSha256 -notmatch '^[0-9A-F]{64}$') {
      throw "invalid_build_value"
    }

    $stage = "trust_import"
    foreach ($store in $stores) {
      $entry = Join-Path $store $expectedThumbprint
      if (-not (Test-Path -LiteralPath $entry)) {
        $addedStores.Add($store)
        Import-Certificate -FilePath $certificatePath -CertStoreLocation $store | Out-Null
      }
      $trustedCertificate = Get-Item -LiteralPath $entry
      if ([Convert]::ToBase64String($trustedCertificate.RawData) -cne [Convert]::ToBase64String($certificate.RawData)) {
        throw "trusted_certificate_mismatch"
      }
    }

    $stage = "artifact_verification"
    Assert-ExpectedSignature $controllerPath
    Assert-ExpectedSignature $helperPath
    Assert-ExpectedSignature $setupPath
    if ((Get-LockedSha256 $locks[$helperPath]) -cne $expectedHelperSha256 -or
        (Get-LockedSha256 $locks[$setupPath]) -cne $expectedSetupSha256) {
      throw "artifact_hash_mismatch"
    }
    $registeredManager = Get-RegisteredManagerPaths
    if ($null -ne $registeredManager) {
      $installedManagerPath = $registeredManager.ManagerPath
      $installedUninstallerPath = $registeredManager.UninstallerPath
    } else {
      $installedManagerRoot = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "Programs\golivebypass-safe"
      $installedManagerPath = Join-Path $installedManagerRoot "GoLiveBypass Safe.exe"
      $installedUninstallerPath = Join-Path $installedManagerRoot "Uninstall GoLiveBypass Safe.exe"
    }
    $installedManagerRoot = [IO.Path]::GetFullPath((Split-Path -Parent $installedManagerPath))
    $managerRootInitiallyExisted = Test-Path -LiteralPath $installedManagerRoot
    $managerInitiallyInstalled = (Test-Path -LiteralPath $installedManagerPath) -or (Test-Path -LiteralPath $installedUninstallerPath)

    $stage = "sac_read"
    $priorSacState = Get-SacState
    if (@("missing", "0", "1", "2") -cnotcontains $priorSacState) {
      throw "unexpected_sac_state"
    }

    $stage = "helper_launch"
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $listener.Server.ExclusiveAddressUse = $true
    $listener.Start(1)
    $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    $tokenBytes = New-Object byte[] 32
    $random = New-Object Security.Cryptography.RNGCryptoServiceProvider
    try {
      $random.GetBytes($tokenBytes)
    } finally {
      $random.Dispose()
    }
    $token = ([BitConverter]::ToString($tokenBytes)).Replace("-", "")
    if ($priorSacState -eq "1") {
      $cleanupMutexCreated = $false
      $cleanupMutexName = "Local\GoLiveBypassSafeCleanup-$token"
      $cleanupMutex = [Threading.Mutex]::new($true, $cleanupMutexName, [ref]$cleanupMutexCreated)
      if (-not $cleanupMutexCreated) {
        $cleanupMutex.Dispose()
        $cleanupMutex = $null
        throw "cleanup_mutex_already_exists"
      }
      $cleanupMutexOwned = $true
    }
    $systemPowerShell = Join-Path ([Environment]::SystemDirectory) "WindowsPowerShell\v1.0\powershell.exe"
    $helperArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Port {1} -Token {2} -ExpectedState {3} -TimeoutSeconds {4}' -f $helperPath, $port, $token, $priorSacState, $helperTimeoutSeconds
    $helperProcess = Start-Process -FilePath $systemPowerShell -Verb RunAs -ArgumentList $helperArguments -PassThru
    $helperCreationTime = ([DateTimeOffset]$helperProcess.StartTime).ToUnixTimeMilliseconds()

    $stage = "helper_handshake"
    $acceptResult = $listener.BeginAcceptTcpClient($null, $null)
    if (-not $acceptResult.AsyncWaitHandle.WaitOne(30000)) {
      throw "helper_connect_timeout"
    }
    $client = $listener.EndAcceptTcpClient($acceptResult)
    $listener.Stop()
    $listener = $null
    $stream = $client.GetStream()
    $stream.ReadTimeout = $helperTimeoutSeconds * 1000
    $stream.WriteTimeout = 10000
    $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::ASCII, $false, 256, $true)
    $writer = New-Object IO.StreamWriter($stream, [Text.Encoding]::ASCII, 256, $true)
    $writer.NewLine = "`n"
    $writer.AutoFlush = $true
    if ((Read-ProtocolLine $reader) -cne "HELLO $token") {
      throw "helper_hello_invalid"
    }
    $writer.WriteLine("AUTH $token")
    $helperCouldChangeSac = $true
    if ((Read-ProtocolLine $reader) -cne "READY $token $priorSacState") {
      throw "helper_ready_invalid"
    }

    $stage = "setup"
    $setupStarted = $true
    Invoke-BoundedProcess $setupPath ('/S /D={0}' -f $installedManagerRoot) $applicationTimeoutSeconds
    $stage = "manager_authentication"
    $registeredManager = Get-RegisteredManagerPaths
    if ($null -eq $registeredManager) {
      throw "manager_registration_missing"
    }
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals($registeredManager.ManagerPath, $installedManagerPath) -or
        -not [StringComparer]::OrdinalIgnoreCase.Equals($registeredManager.UninstallerPath, $installedUninstallerPath)) {
      throw "manager_registration_mismatch"
    }
    $installedManagerPath = Assert-RegularFileWithoutReparsePoints $registeredManager.ManagerPath
    $installedUninstallerPath = $registeredManager.UninstallerPath
    $installedManagerRoot = Split-Path -Parent $installedManagerPath
    $managerTreeSha256 = Get-LockedManagerTreeSha256 $installedManagerRoot $installedUninstallerPath
    Assert-ExpectedSignature $installedManagerPath
    if ($managerTreeSha256 -cne $expectedManagerTreeSha256) {
      throw "manager_tree_hash_mismatch"
    }
    $stage = "manager"
    Assert-ManagerTreeMatchesLocks $installedManagerRoot $installedUninstallerPath
    $managerStarted = $true
    Invoke-BoundedProcess $installedManagerPath "--install-and-exit" $applicationTimeoutSeconds

    $stage = "commit"
    $applicationRollbackSafe = $priorSacState -ne "1"
    Exit-CleanupMutex
    $writer.WriteLine("COMMIT $token")
    try {
      $commitResponse = Read-ProtocolLine $reader
    } catch {
      $commitResponse = $null
    }
    if ($commitResponse -ceq "ROLLBACK_READY $token") {
      Enter-CleanupMutex
      $applicationRollbackSafe = $true
      throw "helper_commit_restore_failed"
    }
    if ($commitResponse -ceq "ROLLED_BACK $token") {
      $sacRollbackAcknowledged = $true
      throw "helper_commit_rolled_back"
    }
    if (-not $helperProcess.WaitForExit(30000)) {
      throw "helper_exit_timeout"
    }
    if ($helperProcess.ExitCode -ne 0) {
      throw "helper_exit_$($helperProcess.ExitCode)"
    }
    $successRecord = "GOLIVE_AUTOMATION_OK version=$releaseVersion commit=$sourceCommit state=$sourceState"
  }
} catch {
  $failure = $_
  $failureStage = $stage
  if ($managerStarted -and $applicationRollbackSafe) {
    try {
      $stage = "application_restore"
      Assert-ManagerTreeMatchesLocks $installedManagerRoot $installedUninstallerPath
      Invoke-BoundedProcess $installedManagerPath "--restore-before-uninstall" $cleanupTimeoutSeconds
    } catch {
      $applicationRollbackConfirmed = $false
    }
  } elseif ($managerStarted) {
    $applicationRollbackConfirmed = $false
  }
  if ($setupStarted -and -not $managerInitiallyInstalled -and -not $managerRootInitiallyExisted -and $applicationRollbackSafe -and $applicationRollbackConfirmed) {
    try {
      $stage = "manager_cleanup"
      foreach ($filePath in @($managerTreeLockPaths)) {
        $locks[$filePath].Dispose()
        [void]$locks.Remove($filePath)
      }
      $managerTreeLockPaths.Clear()
      $uninstallerCleanupFailed = $false
      if (Test-Path -LiteralPath $installedUninstallerPath) {
        try {
          $installedUninstallerPath = Assert-RegularFileWithoutReparsePoints $installedUninstallerPath
          $uninstallerLock = [IO.File]::Open($installedUninstallerPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
          try {
            Assert-ExpectedSignature $installedUninstallerPath
            Invoke-BoundedProcess $installedUninstallerPath "/S" $cleanupTimeoutSeconds $uninstallerLock
            $uninstallerLock = $null
          } finally {
            if ($null -ne $uninstallerLock) {
              $uninstallerLock.Dispose()
            }
          }
        } catch {
          $uninstallerCleanupFailed = $true
        }
      }
      if (Test-Path -LiteralPath $installedManagerRoot) {
        $current = $installedManagerRoot
        while ($true) {
          $item = Get-Item -LiteralPath $current -Force
          if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "manager_cleanup_reparse_point"
          }
          $parent = [IO.Directory]::GetParent($current)
          if ($null -eq $parent) {
            break
          }
          $current = $parent.FullName
        }
        $pending = New-Object Collections.Generic.Queue[string]
        $pending.Enqueue($installedManagerRoot)
        while ($pending.Count -ne 0) {
          $directory = $pending.Dequeue()
          foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
              throw "manager_cleanup_reparse_point"
            }
            if ($item.PSIsContainer) {
              $pending.Enqueue($item.FullName)
            }
          }
        }
        Remove-Item -LiteralPath $installedManagerRoot -Recurse -Force
      }
      if ((Test-Path -LiteralPath $installedManagerPath) -or (Test-Path -LiteralPath $installedUninstallerPath)) {
        $applicationRollbackConfirmed = $false
      }
      if ($uninstallerCleanupFailed) {
        $applicationRollbackConfirmed = $false
      }
    } catch {
      $applicationRollbackConfirmed = $false
    }
  } elseif ($setupStarted -and -not $managerInitiallyInstalled) {
    $applicationRollbackConfirmed = $false
  }
  try {
    Exit-CleanupMutex
  } catch {
  }
  if (-not $cleanupMutexOwned -and $helperCouldChangeSac -and -not $sacRollbackAcknowledged -and $null -ne $writer -and $null -ne $reader) {
    try {
      $stage = "sac_abort"
      $writer.WriteLine("ABORT $token")
      $sacRollbackAcknowledged = (Read-ProtocolLine $reader) -ceq "ROLLED_BACK $token"
    } catch {
      $sacRollbackAcknowledged = $false
    }
  }
} finally {
  if ($null -ne $cleanupMutex) {
    try {
      Exit-CleanupMutex
    } catch {
    }
    $cleanupMutex.Dispose()
  }
  if ($null -ne $writer) {
    try {
      $writer.Dispose()
    } catch {
    }
  }
  if ($null -ne $reader) {
    try {
      $reader.Dispose()
    } catch {
    }
  }
  if ($null -ne $stream) {
    try {
      $stream.Dispose()
    } catch {
    }
  }
  if ($null -ne $client) {
    try {
      $client.Close()
    } catch {
    }
  }
  if ($null -ne $listener) {
    try {
      $listener.Stop()
    } catch {
    }
  }
}

$sacRollbackConfirmed = $true
$trustCleanupConfirmed = $true
if ($null -ne $failure) {
  if ($null -ne $helperProcess) {
    try {
      if (-not $helperProcess.HasExited -and -not $helperProcess.WaitForExit(30000)) {
        $helperProcesses = @{ $helperProcess.Id = $helperCreationTime }
        Stop-ProcessTree $helperProcesses
        $sacRollbackConfirmed = $false
      }
    } catch {
      $sacRollbackConfirmed = $false
    }
  }
  if ($helperCouldChangeSac -and $priorSacState -eq "1" -and -not $sacRollbackAcknowledged) {
    $sacRollbackConfirmed = $false
  }
  if ($null -ne $priorSacState) {
    try {
      if ((Get-SacState) -cne $priorSacState) {
        $sacRollbackConfirmed = $false
      }
    } catch {
      $sacRollbackConfirmed = $false
    }
  }
  if ($addedStores.Count -ne 0) {
    $trustCleanupConfirmed = Remove-AddedTrust ($addedStores.ToArray())
  }
  if ($trustRemovalUnconfirmed) {
    $trustCleanupConfirmed = $false
  }
}

foreach ($lock in $locks.Values) {
  $lock.Dispose()
}

if ($null -eq $failure) {
  [Console]::Out.WriteLine($successRecord)
  exit 0
}
if (-not $sacRollbackConfirmed -or -not $trustCleanupConfirmed -or -not $applicationRollbackConfirmed) {
  [Console]::Error.WriteLine("GOLIVE_AUTOMATION_ROLLBACK_UNCONFIRMED code=2 stage=$failureStage app=$($applicationRollbackConfirmed.ToString().ToLowerInvariant()) sac=$($sacRollbackConfirmed.ToString().ToLowerInvariant()) trust=$($trustCleanupConfirmed.ToString().ToLowerInvariant())")
  exit 2
}
[Console]::Error.WriteLine("GOLIVE_AUTOMATION_ERROR code=1 stage=$failureStage")
exit 1
