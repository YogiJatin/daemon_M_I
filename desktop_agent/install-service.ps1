# desktop_agent/install-service.ps1 - Windows PowerShell 5.1 safe autostart task installer (A9)
# No elevation required; runs as standard unprivileged user at log on

$ErrorActionPreference = "Stop"
$TaskName = "PersonalAIOS-DesktopMirror"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$AgentScript = Join-Path $ScriptDir "mirror_agent.ts"

# Scheduled task action: runs mirror agent in the background
$Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c cd /d `"$ProjectDir`" && npx tsx `"$AgentScript`"" -WorkingDirectory $ProjectDir

# Trigger: At logon of current user
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Settings: run on battery, restart on failure (3 retries, 1 min interval), no execution timeout
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 0)

# Unregister previous task if already exists
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

# Register new scheduled task without elevation
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Personal AI OS Desktop Outbox Mirror Agent"

Write-Output "Personal AI OS Desktop Agent autostart task '$TaskName' installed successfully."
Write-Output "Trigger: At Log On ($env:USERNAME)"
Write-Output "Settings: Runs on battery, restarts 3 times on failure."
