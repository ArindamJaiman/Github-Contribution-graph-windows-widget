# Creates a Start Menu shortcut for the widget with a Ctrl+Alt+F hotkey.
# The hotkey launches the widget when it isn't running; while it runs, the
# app's own global shortcut (configurable in Settings > Behavior) takes over.
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Candidates = @(
    (Join-Path $ProjectRoot "src-tauri\target\release\app.exe"),
    (Join-Path $ProjectRoot "src-tauri\target\debug\app.exe")
)
$TargetPath = $Candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $TargetPath) {
    Write-Error "No built widget found. Run 'npm run build' first."
    exit 1
}

$WshShell = New-Object -ComObject WScript.Shell
$StartMenu = [Environment]::GetFolderPath("StartMenu")
$Shortcut = $WshShell.CreateShortcut("$StartMenu\Programs\GitHub Contribution Widget.lnk")
$Shortcut.TargetPath = $TargetPath
$Shortcut.WorkingDirectory = Split-Path $TargetPath
$Shortcut.Hotkey = "CTRL+ALT+F"
$Shortcut.Save()
Write-Host "Shortcut created -> $TargetPath"
