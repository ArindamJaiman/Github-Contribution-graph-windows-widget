$WshShell = New-Object -comObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("$Home\Desktop\GitHub Contribution Widget.lnk")
$Shortcut.TargetPath = "C:\Users\Mr.Jaiman's Laptop\Desktop\Github Contribution Graph Windows\dist\GitHubContributionWidget.exe"
$Shortcut.WorkingDirectory = "C:\Users\Mr.Jaiman's Laptop\Desktop\Github Contribution Graph Windows\dist"
$Shortcut.Hotkey = "CTRL+ALT+G"
$Shortcut.Save()
