fn main() {
    #[cfg(target_os = "windows")]
    {
        let src_icon = std::path::Path::new("icons/icon_backup.ico");
        let dest_icon = std::path::Path::new("C:\\Users\\Public\\github_widget_icon.ico");

        if src_icon.exists() {
            let _ = std::fs::copy(src_icon, dest_icon);
        }

        let mut windows = tauri_build::WindowsAttributes::new();
        if dest_icon.exists() {
            windows = windows.window_icon_path("C:\\Users\\Public\\github_widget_icon.ico");
        } else {
            windows = windows.window_icon_path("icons/icon_backup.ico");
        }

        let attrs = tauri_build::Attributes::new().windows_attributes(windows);
        tauri_build::try_build(attrs).expect("failed to run build script");
    }

    #[cfg(not(target_os = "windows"))]
    {
        tauri_build::build();
    }
}
