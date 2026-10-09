<#
.SYNOPSIS
  Starts the OpenTableBot bridge and operator console for interactive use.

.DESCRIPTION
  Brings up everything the operator console needs, in order:

    1. the local bridge (unless something is already listening on its port);
    2. the operator console on the loopback port;
    3. the console page in your default browser.

  Both processes run hidden and log to .local/logs. Stop them with
  stop-opentable.ps1, which is what the "Stop OpenTable" desktop icon runs.

  The console defaults to DRY_RUN. Pass -Execute to allow armed tasks to submit
  real reservations from the console; that mode is fixed when the process starts
  and cannot be raised from the loopback page.

  This script does not sign in to OpenTable. Chrome must already be signed in to
  the profile it opens.

  Pass -HoldOnError when launching from a shortcut so a failure stays on screen
  instead of closing the window before it can be read.

.EXAMPLE
  .\start-opentable.ps1

.EXAMPLE
  .\start-opentable.ps1 -Execute -NoBrowser

.EXAMPLE
  # What the desktop icon runs: keep a failed start on screen
  .\start-opentable.ps1 -HoldOnError
#>
param(
  [int]$Port = 8790,
  [int]$BridgePort = 38471,
  [switch]$Execute,
  [switch]$NoBrowser,
  [switch]$NoConsole,
  [switch]$HoldOnError,
  [int]$WaitSeconds = 45
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "opentable-runtime.ps1")

$repo = Get-OpenTableRepoRoot -ScriptRoot $PSScriptRoot
Set-Location $repo
$logDirectory = Get-OpenTableLogDirectory -RepoRoot $repo
Get-OpenTableRunDirectory -RepoRoot $repo | Out-Null

# Anything that leaves the stack unusable should be visible after the run.
$problems = New-Object System.Collections.Generic.List[string]

try {
  if (-not (Test-Path -LiteralPath (Join-Path $repo "node_modules"))) {
    throw "Dependencies are missing. Run 'npm ci' in $repo, then try again."
  }

  # Keep the bridge port consistent for both children and for the status check.
  $env:OPENTABLE_BRIDGE_PORT = "$BridgePort"

  $existing = Get-OpenTableProcessRecord -RepoRoot $repo
  $bridgePid = $null
  $consolePid = $null
  $bridgeStarted = $false
  $consoleStarted = $false

  Write-Host "OpenTableBot startup" -ForegroundColor Cyan
  Write-Host "Repository: $repo"

  # 1. Bridge.
  if (Test-OpenTablePort -Port $BridgePort) {
    Write-Host "Bridge: already listening on port $BridgePort."
  } else {
    $bridgeProcess = Start-OpenTableBackgroundCommand `
      -Command "npm run opentable:bridge" `
      -WorkingDirectory $repo `
      -LogPath (Join-Path $logDirectory "bridge.log")
    $bridgePid = $bridgeProcess.Id
    $bridgeStarted = $true
    Write-Host "Bridge: starting (pid $bridgePid)."
    if (-not (Wait-OpenTablePort -Port $BridgePort -TimeoutSeconds $WaitSeconds)) {
      $problems.Add("The bridge did not open port $BridgePort within $WaitSeconds seconds. See $(Join-Path $logDirectory 'bridge.log').")
    } else {
      Write-Host "Bridge: listening on port $BridgePort." -ForegroundColor Green
    }
  }

  # 2. Operator console.
  if ($NoConsole) {
    Write-Host "Console: skipped (-NoConsole)."
  } elseif (Test-OpenTablePort -Port $Port) {
    Write-Host "Console: already listening on port $Port."
  } else {
    $uiCommand = "npm run opentable:ui -- --port $Port"
    if ($Execute) { $uiCommand += " --execute" }
    $consoleProcess = Start-OpenTableBackgroundCommand `
      -Command $uiCommand `
      -WorkingDirectory $repo `
      -LogPath (Join-Path $logDirectory "console.log")
    $consolePid = $consoleProcess.Id
    $consoleStarted = $true
    Write-Host "Console: starting (pid $consolePid)."
    if (-not (Wait-OpenTablePort -Port $Port -TimeoutSeconds $WaitSeconds)) {
      $problems.Add("The console did not open port $Port within $WaitSeconds seconds. See $(Join-Path $logDirectory 'console.log').")
    } else {
      Write-Host "Console: listening on port $Port." -ForegroundColor Green
    }
  }

  # Remember what this launcher started so Stop only reports on real processes.
  $mode = "dry-run"
  if ($Execute) { $mode = "execute" }
  Save-OpenTableProcessRecord -RepoRoot $repo -Record ([pscustomobject]@{
    startedAt    = (Get-Date).ToUniversalTime().ToString("o")
    mode         = $mode
    port         = $Port
    bridgePort   = $BridgePort
    bridgePid    = $bridgePid
    consolePid   = $consolePid
    bridgeStartedByLauncher  = $bridgeStarted
    consoleStartedByLauncher = $consoleStarted
    previousRecordPresent    = ($null -ne $existing)
  })

  # 3. Report readiness, then open the console.
  Write-Host ""
  Write-Host "Booking mode: $mode"
  if ($Execute) {
    Write-Host "WRITE MODE: armed tasks submitted from this console create real reservations." -ForegroundColor Yellow
  } else {
    Write-Host "Dry run: no reservation can be submitted from this console." -ForegroundColor Green
  }

  if (-not $NoConsole -and (Test-OpenTablePort -Port $Port)) {
    $statusText = "the status endpoint did not answer yet"
    $sessionAuthenticated = $false
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $status = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/status" -TimeoutSec 15
      $bridgeState = "unreachable"
      if ($status.status.bridgeReachable) { $bridgeState = "reachable" }
      $sessionState = "not authenticated"
      if ($status.status.authenticated) {
        $sessionState = "authenticated"
        $sessionAuthenticated = $true
      }
      $statusText = "bridge $bridgeState, session $sessionState"
    } catch {
      $statusText = "the status endpoint did not answer yet"
      $problems.Add("The console status endpoint did not answer.")
    }
    $ErrorActionPreference = $previousPreference
    Write-Host "Status: $statusText"
    if (-not $sessionAuthenticated) {
      Write-Host "Keep a signed-in OpenTable tab open in Chrome for reads to work." -ForegroundColor Yellow
    }
  }

  if (-not $NoBrowser -and -not $NoConsole -and (Test-OpenTablePort -Port $Port)) {
    Start-Process "http://127.0.0.1:$Port/" | Out-Null
    Write-Host "Opened http://127.0.0.1:$Port/ in your browser."
  }

  Write-Host ""
  Write-Host "Logs: $logDirectory"
  Write-Host "Stop with the 'Stop OpenTable' icon or scripts\stop-opentable.ps1."
} catch {
  $problems.Add($_.Exception.Message)
}

if ($problems.Count -gt 0) {
  Write-Host ""
  Write-Host "OpenTableBot needs attention:" -ForegroundColor Red
  foreach ($problem in $problems) { Write-Host "  - $problem" -ForegroundColor Red }
  # A shortcut window closes the moment the script exits, which would hide the
  # reason. Only hold when a caller asked for it, so automation never blocks.
  if ($HoldOnError) {
    Write-Host ""
    [void](Read-Host "Press Enter to close this window")
  }
  exit 1
}

