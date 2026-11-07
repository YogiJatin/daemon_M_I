# desktop_agent/register_task.ps1 - Windows PowerShell 5.1 safe autostart task
# No elevation required; runs as standard user at log on

$TaskName = "PersonalAIOS-DesktopMirror"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$NodePath = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $NodePath) { $NodePath = "node.exe" }
$AgentScript = Join-Path $ScriptDir "mirror_agent.ts"

$Action = New-ScheduledTaskAction -Execute "npx.cmd" -Argument "tsx `"$AgentScript`"" -WorkingDirectory $ProjectDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Settings: run on battery, restart on failure
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 0)

# Register without elevation
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Personal AI OS Desktop Outbox Mirror Agent"

Write-Output "Scheduled task '$TaskName' registered successfully."
