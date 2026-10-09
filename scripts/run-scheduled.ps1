<#
.SYNOPSIS
  Warms up Chrome and runs the OpenTableBot scheduler for a known drop.

.DESCRIPTION
  Intended to be started a few minutes before a reservation release time, either
  by hand or by the task registered with register-scheduled-task.ps1. It opens the
  restaurant page in the user's normal signed-in Chrome profile, ensures the local
  bridge is running, waits for the extension and an eligible page to report ready,
  then runs the scheduler through the drop.

  Chrome must already be signed in to OpenTable in the profile it opens. This
  script starts Chrome and the bridge; it never signs in for you.

.EXAMPLE
  .\run-scheduled.ps1 -RestaurantUrl "https://www.opentable.com/r/don-angie-new-york" -TargetId don-angie -Execute
#>
param(
  [Parameter(Mandatory = $true)][string]$RestaurantUrl,
  [string]$TargetId = "",
  [switch]$Execute,
  [int]$BridgePort = 38471,
  [int]$MaxRuntimeMinutes = 30,
  [int]$WarmUpSeconds = 180,
  [int]$ReadinessSeconds = 180
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "opentable-runtime.ps1")

$repo = Get-OpenTableRepoRoot -ScriptRoot $PSScriptRoot
Set-Location $repo
$logDirectory = Get-OpenTableLogDirectory -RepoRoot $repo

# 1. Open the restaurant page in the user's normal Chrome profile. When Chrome is
#    already running this opens a tab in the existing instance, which also starts
#    the MV3 service worker so the extension reconnects to the bridge.
$chrome = Find-OpenTableChrome
if ($null -eq $chrome) {
  throw "chrome.exe was not found in the standard install locations."
}
Start-Process -FilePath $chrome -ArgumentList $RestaurantUrl | Out-Null
Write-Host "Opened $RestaurantUrl in Chrome."

# 2. Ensure the local bridge is running. The scheduler reads the same port from
#    the environment, so set it before either process starts.
$env:OPENTABLE_BRIDGE_PORT = "$BridgePort"
if (Test-OpenTablePort -Port $BridgePort) {
  Write-Host "Local bridge already listening on port $BridgePort."
} else {
  Start-OpenTableBackgroundCommand `
    -Command "npm run opentable:bridge" `
    -WorkingDirectory $repo `
    -LogPath (Join-Path $logDirectory "bridge.log") | Out-Null
  Write-Host "Started the local bridge on port $BridgePort (log: $(Join-Path $logDirectory 'bridge.log'))."
  if (-not (Wait-OpenTablePort -Port $BridgePort -TimeoutSeconds 30)) {
    Write-Warning "The bridge did not open port $BridgePort yet; the scheduler will keep waiting for it."
  }
}

# 3. Run the scheduler through the drop. The scheduler itself waits for readiness
#    before the release time and pauses with the reason rather than booking blind.
$schedulerArgs = @(
  "run", "opentable:schedule", "--",
  "--max-runtime-minutes", "$MaxRuntimeMinutes",
  "--warm-up-seconds", "$WarmUpSeconds",
  "--readiness-seconds", "$ReadinessSeconds"
)
if ($TargetId -ne "") { $schedulerArgs += @("--target-id", $TargetId) }
if ($Execute) { $schedulerArgs += "--execute" }
& npm @schedulerArgs
exit $LASTEXITCODE
