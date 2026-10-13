# SocialMonitor as a Windows startup task: it starts with the PC (before anyone signs in),
# restarts within a minute if it stops, and writes its log to data\service.log.
#
# In PowerShell opened as administrator, from the repository:
#   powershell -ExecutionPolicy Bypass -File scripts\windows-service.ps1           install or update
#   powershell -ExecutionPolicy Bypass -File scripts\windows-service.ps1 -Remove   uninstall
#
# Claude sorts comments without anyone signed in only with a token that does not expire with the
# session: run  claude setup-token  once and put CLAUDE_CODE_OAUTH_TOKEN=... in .env.
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$Name = 'SocialMonitor'
$Repo = Split-Path -Parent $PSScriptRoot

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Open PowerShell as administrator, then run this again.' }

if ($Remove) {
  Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false
  Write-Host 'SocialMonitor no longer starts with the PC.'
  exit 0
}

foreach ($cmd in 'node', 'yarn', 'claude') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd is not installed for this user." }
}
$major = [int]((node --version).TrimStart('v').Split('.')[0])
if ($major -lt 22) { throw "SocialMonitor needs Node 22 or newer (found $(node --version))." }
if ((Get-Command claude).Source -like '*.cmd') {
  Write-Warning 'Claude Code is the npm version; install the native one (claude.ai/install.ps1) so SocialMonitor can start it.'
}

$envFile = Join-Path $Repo '.env'
$hasKey = (Test-Path $envFile) -and
  (Select-String -Path $envFile -Pattern '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=.+' -Quiet)
if (-not $hasKey) {
  Write-Warning 'No CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in .env, so comments are not sorted by themselves. Run  claude setup-token  and add CLAUDE_CODE_OAUTH_TOKEN=... to .env.'
}

New-Item -ItemType Directory -Force (Join-Path $Repo 'data') | Out-Null
$log = Join-Path $Repo 'data\service.log'
$yarn = (Get-Command yarn).Source

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -WorkingDirectory $Repo `
  -Argument "/c `"`"$yarn`" start >> `"$log`" 2>&1`""
$trigger = New-ScheduledTaskTrigger -AtStartup
# S4U: runs as this user whether or not anyone is signed in, without storing a password.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $Name
Write-Host "SocialMonitor starts with the PC and restarts if it stops. Open http://127.0.0.1:4400; log: $log"
