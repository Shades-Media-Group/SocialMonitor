# SocialMonitor's backups as Windows scheduled tasks: the encrypted off-site backup every night at
# 02:30, and the restore test every four weeks, on Sunday at 04:00. Both run whether or not anyone is
# signed in, and a run missed while the PC was off starts as soon as it is back. Each run logs to
# data\backup.log; Task Scheduler's "Last Run Result" is 0x0 when it worked.
#
# Set up the repository and its settings first: see "Backups" in docs\server.md. Then, in PowerShell
# opened as administrator, from the repository:
#   powershell -ExecutionPolicy Bypass -File scripts\windows-backup.ps1           install or update
#   powershell -ExecutionPolicy Bypass -File scripts\windows-backup.ps1 -Remove   uninstall
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$Backup = 'SocialMonitor backup'
$RestoreTest = 'SocialMonitor restore test'
$Repo = Split-Path -Parent $PSScriptRoot

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Open PowerShell as administrator, then run this again.' }

if ($Remove) {
  foreach ($task in $Backup, $RestoreTest) {
    Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
  }
  Write-Host 'SocialMonitor backups are no longer scheduled.'
  exit 0
}

foreach ($cmd in 'node', 'restic') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd is not installed for this user." }
}
$node = (Get-Command node).Source
$restic = (Get-Command restic).Source

function Register-Backup($name, $arguments, $trigger) {
  # RESTIC_BIN pins the restic found now, since a task's PATH can differ from this shell's.
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -WorkingDirectory $Repo `
    -Argument "/c `"set `"RESTIC_BIN=$restic`" && `"$node`" scripts\backup.mjs $arguments`""
  # S4U: runs as this user whether or not anyone is signed in, without storing a password.
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 4) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}

Register-Backup $Backup '' (New-ScheduledTaskTrigger -Daily -At '02:30')
# Task Scheduler's cmdlets have no monthly trigger; every four weeks is the closest.
Register-Backup $RestoreTest '--test-restore' (New-ScheduledTaskTrigger -Weekly -WeeksInterval 4 -DaysOfWeek Sunday -At '04:00')

Write-Host "Backups run every night at 02:30; the restore test every four weeks. Log: $(Join-Path $Repo 'data\backup.log')"
Write-Host "Run one now:  Start-ScheduledTask -TaskName '$Backup'"
