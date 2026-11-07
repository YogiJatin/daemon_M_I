# desktop_agent/uninstall-service.ps1 - Unregister autostart task (A9)
$TaskName = "PersonalAIOS-DesktopMirror"
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Output "Personal AI OS Desktop Agent autostart task '$TaskName' uninstalled successfully."
