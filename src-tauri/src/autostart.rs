//! "Launch at startup" via the per-user Run registry key on Windows.
//! Writes the registry directly instead of spawning PowerShell on every launch,
//! and only touches it when the stored value actually differs.

#[cfg(target_os = "windows")]
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(target_os = "windows")]
const VALUE_NAME: &str = "GitHubContributionWidget";

#[cfg(target_os = "windows")]
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey_with_flags(RUN_KEY, KEY_READ | KEY_SET_VALUE)
        .map_err(|e| e.to_string())?;
    let current: Option<String> = key.get_value(VALUE_NAME).ok();

    if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let desired = format!("\"{}\"", exe.display());
        if current.as_deref() != Some(desired.as_str()) {
            key.set_value(VALUE_NAME, &desired).map_err(|e| e.to_string())?;
        }
    } else if current.is_some() {
        key.delete_value(VALUE_NAME).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn set_enabled(_enabled: bool) -> Result<(), String> {
    Ok(())
}
