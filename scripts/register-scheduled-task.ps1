<#
.SYNOPSIS
  Registers a Windows Task Scheduler entry that warms up and runs a known drop.

.DESCRIPTION
  Creates a task that starts run-scheduled.ps1 one minute before the reservation
  release time. The task is registered to wake the machine. Run this from an
  elevated PowerShell prompt.

.EXAMPLE
  .\register-scheduled-task.ps1 -RestaurantUrl "https://www.opentable.com/r/don-angie-new-york" -DropTime "10:00" -DropDate "2026-11-08" -TargetId don-angie -Execute

.EXAMPLE
  # Recurring daily warm-up at 09:59 for a 10:00 drop
  .\register-scheduled-task.ps1 -RestaurantUrl "https://www.opentable.com/r/don-angie-new-york" -DropTime "10:00" -TargetId don-angie
#>
param(
  [Parameter(Mandatory = $true)][string]$RestaurantUrl,
  [Parameter(Mandatory = $true)][string]$DropTime,
  [string]$DropDate = "",
  [string]$TargetId = "",
  [switch]$Execute,
  [string]$TaskName = "OpenTableBot-Drop",
  [int]$WarmUpSeconds = 60
)

$ErrorActionPreference = "Stop"
$scriptPath = Join-Path $PSScriptRoot "run-scheduled.ps1"
if (-not (Test-Path -LiteralPath $scriptPath)) {
  throw "run-scheduled.ps1 was not found next to this script."
}

$drop = [datetime]::ParseExact($DropTime, "HH:mm", [System.Globalization.CultureInfo]::InvariantCulture)
$triggerAt = $drop.AddSeconds(-1 * $WarmUpSeconds)
if ($DropDate -ne "") {
  $date = [datetime]::ParseExact($DropDate, "yyyy-MM-dd", [System.Globalization.CultureInfo]::InvariantCulture)
  $triggerAt = $date.Date.Add($triggerAt.TimeOfDay)
}

$argumentList = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", "`"$scriptPath`"",
  "-RestaurantUrl", "`"$RestaurantUrl`""
)
if ($TargetId -ne "") { $argumentList += @("-TargetId", "`"$TargetId`"") }
if ($Execute) { $argumentList += "-Execute" }

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ($argumentList -join " ")
if ($DropDate -ne "") {
  $trigger = New-ScheduledTaskTrigger -Once -At $triggerAt
} else {
  $trigger = New-ScheduledTaskTrigger -Daily -At $triggerAt
}
$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force
Write-Host "Registered scheduled task '$TaskName' to start at $triggerAt for the $DropTime drop."
