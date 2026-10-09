<#
.SYNOPSIS
  Stops the OpenTableBot bridge and operator console.

.DESCRIPTION
  Stops the processes started by start-opentable.ps1. It kills whole process
  trees, because the launcher starts cmd.exe, which owns npm, which owns tsx,
  which owns the node process that actually holds the port.

  It also stops processes it did not start, matching whatever is listening on
  the console and bridge ports, so a console you launched by hand with
  "npm run opentable:ui" is stopped too.

  Safety: if an unattended scheduled run currently holds the scheduler lock, the
  bridge is left alone and the script exits, because stopping the bridge
  mid-booking would abandon a reservation in flight. Pass -Force to override.

  Pass -HoldOnError when launching from a shortcut so a refusal stays on screen
  instead of closing the window before it can be read.

.EXAMPLE
  .\stop-opentable.ps1

.EXAMPLE
  .\stop-opentable.ps1 -Force

.EXAMPLE
  # What the desktop icon runs: keep a refusal on screen
  .\stop-opentable.ps1 -HoldOnError
#>
param(
  [int]$Port = 8790,
  [int]$BridgePort = 38471,
  [switch]$KeepBridge,
  [switch]$Force,
  [switch]$HoldOnError
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "opentable-runtime.ps1")

$repo = Get-OpenTableRepoRoot -ScriptRoot $PSScriptRoot
Set-Location $repo

Write-Host "OpenTableBot shutdown" -ForegroundColor Cyan

# An unattended drop in progress must not lose its bridge.
$lock = Get-OpenTableSchedulerLock -RepoRoot $repo
if ($null -ne $lock -and -not $Force) {
  Write-Warning "An unattended scheduled run is in progress:"
  Write-Warning "  $($lock.Owner) (pid $($lock.OwnerPid), since $($lock.AcquiredAt))"
  Write-Warning "Stopping the bridge now could abandon a reservation mid-booking."
  Write-Warning "Wait for it to finish, or re-run with -Force to stop anyway."
  # A shortcut window would close before this could be read.
  if ($HoldOnError) {
    Write-Host ""
    [void](Read-Host "Press Enter to close this window")
  }
  exit 1
}
if ($null -ne $lock) {
  Write-Warning "Ignoring the scheduler lock held by $($lock.Owner) (pid $($lock.OwnerPid)) because -Force was given."
}

$record = Get-OpenTableProcessRecord -RepoRoot $repo
$stopped = @()

function Stop-OpenTableTarget {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][int]$TargetPort,
    [AllowNull()][System.Nullable[int]]$RecordedProcessId
  )
  $candidates = @()
  if ($null -ne $RecordedProcessId) { $candidates += [int]$RecordedProcessId }
  $listener = Get-OpenTableListenerProcessId -Port $TargetPort
  if ($null -ne $listener) { $candidates += $listener }
  $candidates = $candidates | Select-Object -Unique

  if ($candidates.Count -eq 0) {
    Write-Host "${Label}: not running."
    return
  }

  foreach ($processId in $candidates) {
    if (Stop-OpenTableProcessTree -ProcessId $processId) {
      Write-Host "${Label}: stopped pid $processId." -ForegroundColor Green
      $script:stopped += "$Label pid $processId"
    }
  }

  # Killing the tree can leave the port closing briefly; confirm it is gone.
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline -and (Test-OpenTablePort -Port $TargetPort)) {
    Start-Sleep -Milliseconds 300
  }
  if (Test-OpenTablePort -Port $TargetPort) {
    Write-Warning "${Label}: port $TargetPort is still listening."
  } else {
    Write-Host "${Label}: port $TargetPort is free."
  }
}

Stop-OpenTableTarget -Label "Console" -TargetPort $Port `
  -RecordedProcessId $(if ($null -ne $record) { $record.consolePid } else { $null })

if ($KeepBridge) {
  Write-Host "Bridge: left running (-KeepBridge)."
} else {
  Stop-OpenTableTarget -Label "Bridge" -TargetPort $BridgePort `
    -RecordedProcessId $(if ($null -ne $record) { $record.bridgePid } else { $null })
}

Remove-OpenTableProcessRecord -RepoRoot $repo

Write-Host ""
if ($stopped.Count -eq 0) {
  Write-Host "Nothing was running."
} else {
  Write-Host "Stopped: $($stopped -join ', ')"
}
Write-Host "Chrome was left open. The extension reconnects when the bridge starts again."
