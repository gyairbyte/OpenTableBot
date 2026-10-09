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
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Find-Chrome {
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
  throw "chrome.exe was not found in the standard install locations."
}

function Test-BridgeListening {
  param([int]$Port)
  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  return [bool]$connection
}

# 1. Open the restaurant page in the user's normal Chrome profile. When Chrome is
#    already running this opens a tab in the existing instance, which also starts
#    the MV3 service worker so the extension reconnects to the bridge.
$chrome = Find-Chrome
Start-Process -FilePath $chrome -ArgumentList $RestaurantUrl | Out-Null
Write-Host "Opened $RestaurantUrl in Chrome."

# 2. Ensure the local bridge is running.
if (-not (Test-BridgeListening -Port $BridgePort)) {
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm run opentable:bridge" -WindowStyle Hidden | Out-Null
  Write-Host "Started the local bridge on port $BridgePort."
  Start-Sleep -Seconds 5
} else {
  Write-Host "Local bridge already listening on port $BridgePort."
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
