# Keeps WSL running from Windows startup, so SocialMonitor's systemd services (scripts/production-setup.sh)
# start with the PC and keep running whether or not anyone is signed in. WSL stops a distribution a
# few seconds after its last Windows-side process ends, systemd services or not; this task is that
# process: a `sleep infinity` that starts at boot and starts again within a minute if it stops.
#
# In PowerShell opened as administrator:
#   powershell -ExecutionPolicy Bypass -File scripts\windows-wsl-boot.ps1 -Distro Ubuntu           install or update
#   powershell -ExecutionPolicy Bypass -File scripts\windows-wsl-boot.ps1 -Remove                  uninstall
#
# For a PC without WSL, scripts\windows-service.ps1 runs SocialMonitor on Windows itself instead.
param([switch]$Remove, [string]$Distro = 'Ubuntu')
$ErrorActionPreference = 'Stop'
$Name = 'SocialMonitor WSL'

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Open PowerShell as administrator, then run this again.' }

if ($Remove) {
  Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host 'WSL no longer starts with the PC (it still starts when you open it).'
  exit 0
}

$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
# wsl -l -q writes UTF-16; the NULs are dropped before comparing.
$distros = (& $wsl -l -q) -replace "`0", '' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($distros -notcontains $Distro) {
  throw "No WSL distribution named '$Distro'. Installed: $($distros -join ', '). Pass -Distro <name>."
}

$action = New-ScheduledTaskAction -Execute $wsl -Argument "-d $Distro --exec /bin/sh -c `"exec sleep infinity`""
$trigger = New-ScheduledTaskTrigger -AtStartup
# S4U: runs as this user whether or not anyone is signed in, without storing a password. WSL
# distributions belong to a Windows user, so it must be the user who installed Ubuntu.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $Name
Start-Sleep -Seconds 5
$state = (Get-ScheduledTask -TaskName $Name).State
Write-Host "WSL ($Distro) starts with the PC and stays running. The task is $state."
Write-Host "Check after a restart, before signing in to Windows: from another device, yarn deploy:verify;"
Write-Host "or once signed in:  wsl -d $Distro --exec systemctl is-active socialmonitor"
Write-Host 'Also keep the PC awake on mains power: powercfg /change standby-timeout-ac 0'
