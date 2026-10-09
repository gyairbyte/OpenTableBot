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
