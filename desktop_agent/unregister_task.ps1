# desktop_agent/unregister_task.ps1 - Unregister autostart task
$TaskName = "PersonalAIOS-DesktopMirror"
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Output "Scheduled task '$TaskName' removed successfully."
