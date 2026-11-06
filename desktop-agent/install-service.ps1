# desktop-agent/install-service.ps1
# Registers autostart for the Personal AI OS Desktop Agent at user logon without requiring elevation.

$taskName = "PersonalAIOS-DesktopAgent"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = Split-Path -Parent $scriptDir

Write-Host "Registering autostart for Personal AI OS Desktop Agent..."

# Attempt 1: Scheduled Task (per owner instruction: Register-ScheduledTask, no execution limit, runs on battery)
$registeredTask = $false
try {
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -Command ""Set-Location '$repoDir'; npx tsx desktop-agent/obsidian-writer.ts"""
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "Personal AI OS Obsidian Writer & Desktop Agent" -Force -ErrorAction Stop
    Write-Host " Registered Scheduled Task: $taskName"
    $registeredTask = $true
} catch {
    Write-Host " Scheduled Task root registration restricted without elevation ($($_.Exception.Message))."
}

# Attempt 2: Standard user Startup folder (Rule 30 compliant: guaranteed zero elevation)
$startupFolder = [System.IO.Path]::Combine($env:APPDATA, "Microsoft\Windows\Start Menu\Programs\Startup")
$shortcutPath = Join-Path $startupFolder "PersonalAIOS-DesktopAgent.lnk"

try {
    $wscript = New-Object -ComObject WScript.Shell
    $shortcut = $wscript.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = "powershell.exe"
    $shortcut.Arguments = "-NoProfile -WindowStyle Hidden -Command ""Set-Location '$repoDir'; npx tsx desktop-agent/obsidian-writer.ts"""
    $shortcut.WorkingDirectory = $repoDir
    $shortcut.Description = "Personal AI OS Obsidian Writer & Desktop Agent"
    $shortcut.Save()
    Write-Host " Registered User Logon Shortcut in Startup folder: $shortcutPath"
} catch {
    Write-Error "Failed to register Startup shortcut: $($_.Exception.Message)"
}

Write-Host "`nDesktop Agent autostart is active. It will run at every Windows logon."

