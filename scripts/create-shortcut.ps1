$WshShell = New-Object -comObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("$Home\Desktop\GitHub Contribution Widget.lnk")

$ReleasePath = "C:\Users\Mr.Jaiman's Laptop\Desktop\Github Contribution Graph Windows\src-tauri\target\release\github-contribution-widget.exe"
$DebugPath = "C:\Users\Mr.Jaiman's Laptop\Desktop\Github Contribution Graph Windows\src-tauri\target\debug\app.exe"
$LegacyPath = "C:\Users\Mr.Jaiman's Laptop\Desktop\Github Contribution Graph Windows\dist\GitHubContributionWidget.exe"

if (Test-Path $ReleasePath) {
    $TargetPath = $ReleasePath
    $WorkingDir = Split-Path $ReleasePath
} elseif (Test-Path $DebugPath) {
    $TargetPath = $DebugPath
    $WorkingDir = Split-Path $DebugPath
} else {
    $TargetPath = $LegacyPath
    $WorkingDir = Split-Path $LegacyPath
}

$Shortcut.TargetPath = $TargetPath
$Shortcut.WorkingDirectory = $WorkingDir
$Shortcut.Hotkey = "CTRL+ALT+G"
$Shortcut.Save()
