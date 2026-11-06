# desktop-agent/uninstall-service.ps1
# Removes autostart registration for Personal AI OS Desktop Agent

$taskName = "PersonalAIOS-DesktopAgent"

try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Unregistered scheduled task $taskName (if existed)."
} catch {}

$startupFolder = [System.IO.Path]::Combine($env:APPDATA, "Microsoft\Windows\Start Menu\Programs\Startup")
$shortcutPath = Join-Path $startupFolder "PersonalAIOS-DesktopAgent.lnk"

if (Test-Path $shortcutPath) {
    Remove-Item $shortcutPath -Force
    Write-Host "Removed startup shortcut: $shortcutPath"
} else {
    Write-Host "No startup shortcut found at $shortcutPath."
}

Write-Host "Desktop Agent autostart uninstalled successfully."
