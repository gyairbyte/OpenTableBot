<#
.SYNOPSIS
  Shared helpers for the OpenTableBot start/stop launchers.

.DESCRIPTION
  Dot-source this file from a launcher script. It only reads local state and
  starts or stops processes the launcher itself owns; it never touches
  OpenTable account data, cookies, or the bridge credential.
#>

function Get-OpenTableRepoRoot {
  param([Parameter(Mandatory = $true)][string]$ScriptRoot)
  return (Split-Path -Parent $ScriptRoot)
}

function Get-OpenTableRunDirectory {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)
  $directory = Join-Path $RepoRoot ".local\run"
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  return $directory
}

function Get-OpenTableLogDirectory {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)
  $directory = Join-Path $RepoRoot ".local\logs"
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  return $directory
}

function Get-OpenTableProcessRecordPath {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)
  return (Join-Path $RepoRoot ".local\run\processes.json")
}

function Test-OpenTablePort {
  param([Parameter(Mandatory = $true)][int]$Port)
  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  return [bool]$connection
}

function Get-OpenTableListenerProcessId {
  param([Parameter(Mandatory = $true)][int]$Port)
  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -eq $connection) { return $null }
  return [int]$connection.OwningProcess
}

function Stop-OpenTableProcessTree {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $false }
  # The launchers start cmd.exe, which owns npm, which owns tsx, which owns
  # node. Only a tree kill reaches the process that actually holds the port.
  # taskkill reports missing children on stderr, which would otherwise surface
  # as a terminating error under $ErrorActionPreference = "Stop".
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & taskkill /PID $ProcessId /T /F 2>&1 | Out-Null
  } catch {
    # A process that exited between the check and the kill needs no handling.
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  return $true
}

<#
  Starts a hidden background command and returns its process id.

  The command runs through cmd.exe so it can redirect its own output to log
  files. That matters: PowerShell's -RedirectStandardOutput would give the child
  our handles, and the npm/tsx/node grandchildren would then keep the launcher's
  stdout open after it exits. Anything reading that pipe (a parent shell, a
  desktop shortcut host) would hang instead of returning. Letting cmd own the
  redirection leaves the launched process fully detached.
#>
function Start-OpenTableBackgroundCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$LogPath
  )
  $wrapped = "$Command > `"$LogPath`" 2>&1"
  return (Start-Process -FilePath "cmd.exe" `
    -ArgumentList @("/c", $wrapped) `
    -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru)
}

function Get-OpenTableProcessRecord {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)
  $path = Get-OpenTableProcessRecordPath -RepoRoot $RepoRoot
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try {
    return (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Save-OpenTableProcessRecord {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)]$Record
  )
  $path = Get-OpenTableProcessRecordPath -RepoRoot $RepoRoot
  # Set-Content -Encoding UTF8 writes a BOM on Windows PowerShell 5.1, which
  # would break any strict JSON reader. WriteAllText emits UTF-8 with no BOM.
  [System.IO.File]::WriteAllText($path, ($Record | ConvertTo-Json))
}

function Remove-OpenTableProcessRecord {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)
  $path = Get-OpenTableProcessRecordPath -RepoRoot $RepoRoot
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}

<#
  Reads the unattended scheduler lock. A lock whose process is gone is treated
  as absent, matching the Node side, so a crashed run never wedges the launcher.
#>
function Get-OpenTableSchedulerLock {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)
  $path = Join-Path $RepoRoot ".local\state\scheduler.lock"
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try {
    $info = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
  $ownerProcess = Get-Process -Id ([int]$info.pid) -ErrorAction SilentlyContinue
  if ($null -eq $ownerProcess) { return $null }
  return [pscustomobject]@{
    Path       = $path
    OwnerPid   = [int]$info.pid
    Owner      = [string]$info.owner
    AcquiredAt = [string]$info.acquiredAt
  }
}

function Find-OpenTableChrome {
  $candidates = @()
  if ($env:ProgramFiles) {
    $candidates += (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe")
  }
  if (${env:ProgramFiles(x86)}) {
    $candidates += (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe")
  }
  if ($env:LOCALAPPDATA) {
    $candidates += (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
  }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return $null
}

<#
  Finds the Chrome profile folder (for example "Default" or "Profile 2") that
  has this repo's unpacked extension loaded.

  A bare `chrome.exe <url>` opens the profile Chrome last used, which may be one
  without the extension: the tab then never binds and every target pauses with
  "no eligible OpenTable page". Chrome records an unpacked extension's path in
  each profile's "Secure Preferences", so the profile is found by matching the
  repo's dist\extension path. The profile display name is irrelevant, so
  renaming a profile cannot break this. Returns $null when no single profile
  matches (none, or more than one), and the caller falls back to Chrome's choice.
#>
function Get-OpenTableChromeProfile {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [string]$Override = ""
  )
  if ($Override -ne "") { return $Override }
  if (-not $env:LOCALAPPDATA) { return $null }
  $userData = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"
  if (-not (Test-Path -LiteralPath $userData)) { return $null }
  # Chrome writes the path as JSON, so each backslash is doubled in the file.
  $extensionPath = (Join-Path $RepoRoot "dist\extension").Replace("\", "\\")
  $found = @()
  foreach ($directory in (Get-ChildItem -LiteralPath $userData -Directory -ErrorAction SilentlyContinue)) {
    $securePreferences = Join-Path $directory.FullName "Secure Preferences"
    if (-not (Test-Path -LiteralPath $securePreferences)) { continue }
    try {
      $raw = Get-Content -LiteralPath $securePreferences -Raw -ErrorAction Stop
    } catch {
      continue
    }
    if ($raw.IndexOf($extensionPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $found += $directory.Name
    }
  }
  if ($found.Count -eq 1) { return $found[0] }
  return $null
}

<#
  Builds the chrome.exe arguments that open a URL in the profile that has the
  extension. Warns, and leaves the choice to Chrome, when the profile cannot be
  determined.
#>
function Get-OpenTableChromeArguments {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$Url,
    [string]$ChromeProfile = ""
  )
  $profileName = Get-OpenTableChromeProfile -RepoRoot $RepoRoot -Override $ChromeProfile
  $arguments = @()
  if ($profileName) {
    $arguments += "--profile-directory=`"$profileName`""
  } else {
    Write-Warning ("Could not tell which Chrome profile has the OpenTableBot extension, " +
      "so Chrome will use its last-used profile. If the page does not bind, " +
      "pass -ChromeProfile (for example `"Default`").")
  }
  $arguments += $Url
  return ,$arguments
}

<#
  Waits for a TCP listener, reporting whether it appeared. Used so a launcher
  can tell the operator that startup actually succeeded rather than assuming it.
#>
function Wait-OpenTablePort {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-OpenTablePort -Port $Port) { return $true }
    Start-Sleep -Milliseconds 400
  }
  return (Test-OpenTablePort -Port $Port)
}
