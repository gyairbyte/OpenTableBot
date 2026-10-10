<#
.SYNOPSIS
  Creates "Start OpenTable" and "Stop OpenTable" shortcuts on the Desktop.

.DESCRIPTION
  Writes two .lnk files that run start-opentable.ps1 and stop-opentable.ps1 with
  a hidden-friendly, execution-policy-bypassing PowerShell invocation, so the
  icons work without any shell setup. The Start shortcut is live by default;
  pass -DryRun to install a non-submitting shortcut.

  Re-running the script overwrites the existing shortcuts, so it is safe to run
  again after moving the repository. Delete the .lnk files to remove them.

.EXAMPLE
  .\install-desktop-shortcuts.ps1

.EXAMPLE
  .\install-desktop-shortcuts.ps1 -DryRun

.EXAMPLE
  .\install-desktop-shortcuts.ps1 -DesktopPath "C:\Users\me\Desktop"
#>
param(
  [string]$DesktopPath = "",
  [switch]$WriteMode,
  [switch]$DryRun,
  [string]$StartIcon = "",
  [string]$StopIcon = "",
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
if ($WriteMode -and $DryRun) {
  throw "Use either -WriteMode or -DryRun, not both."
}
$writeMode = -not $DryRun
. (Join-Path $PSScriptRoot "opentable-runtime.ps1")

$repo = Get-OpenTableRepoRoot -ScriptRoot $PSScriptRoot
$startScript = Join-Path $PSScriptRoot "start-opentable.ps1"
$stopScript = Join-Path $PSScriptRoot "stop-opentable.ps1"

foreach ($required in @($startScript, $stopScript)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Missing launcher script: $required"
  }
}

$desktop = $DesktopPath
if ($desktop -eq "") {
  $desktop = [Environment]::GetFolderPath("Desktop")
}
if (-not (Test-Path -LiteralPath $desktop)) {
  throw "Desktop directory was not found: $desktop"
}

$startShortcutPath = Join-Path $desktop "Start OpenTable.lnk"
$stopShortcutPath = Join-Path $desktop "Stop OpenTable.lnk"

if ($Remove) {
  foreach ($path in @($startShortcutPath, $stopShortcutPath)) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Force
      Write-Host "Removed $path"
    }
  }
  return
}

$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $powershell)) {
  throw "powershell.exe was not found at $powershell"
}

# Icons are cosmetic. Default the Start icon to Chrome because that is what it
# opens, and the Stop icon to a shell icon; both are overridable.
if ($StartIcon -eq "") {
  $chrome = Find-OpenTableChrome
  if ($null -ne $chrome) { $StartIcon = "$chrome,0" }
}
if ($StopIcon -eq "") {
  $StopIcon = "$(Join-Path $env:SystemRoot 'System32\shell32.dll'),27"
}

$startArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`" -HoldOnError"
if ($writeMode) { $startArguments += " -Execute" } else { $startArguments += " -DryRun" }

$shell = New-Object -ComObject WScript.Shell

$startShortcut = $shell.CreateShortcut($startShortcutPath)
$startShortcut.TargetPath = $powershell
$startShortcut.Arguments = $startArguments
$startShortcut.WorkingDirectory = $repo
if ($writeMode) {
  $startShortcut.Description = "Start the OpenTableBot bridge and console in WRITE mode (real reservations)"
} else {
  $startShortcut.Description = "Start the OpenTableBot bridge and console (dry run)"
}
if ($StartIcon -ne "") { $startShortcut.IconLocation = $StartIcon }
$startShortcut.Save()

$stopShortcut = $shell.CreateShortcut($stopShortcutPath)
$stopShortcut.TargetPath = $powershell
$stopShortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$stopScript`" -HoldOnError"
$stopShortcut.WorkingDirectory = $repo
$stopShortcut.Description = "Stop the OpenTableBot bridge and console"
if ($StopIcon -ne "") { $stopShortcut.IconLocation = $StopIcon }
$stopShortcut.Save()

Write-Host "Desktop shortcuts created in $desktop" -ForegroundColor Green
Write-Host "  Start OpenTable  -> $startArguments"
if ($writeMode) {
  Write-Host "                     (WRITE MODE: real reservations can be submitted)" -ForegroundColor Yellow
} else {
  Write-Host "                     (dry run)"
}
Write-Host "  Stop OpenTable   -> $($stopShortcut.Arguments)"
Write-Host ""
Write-Host "Double-click 'Start OpenTable' to launch, 'Stop OpenTable' to shut down."
