//! Persistent configuration, caches and window positions (JSON files in the
//! app data directory). Writes are atomic (temp file + rename) so a crash or
//! power loss mid-write can't corrupt the config.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::github::{is_valid_username, CachedData};

pub const THEMES: &[&str] = &[
    "green", "blue", "purple", "pink", "orange", "yellow", "coral", "cyan", "teal", "magenta",
    "indigo", "halloween", "mono",
];
pub const WINDOW_LAYERS: &[&str] = &["normal", "top", "bottom"];
pub const MAX_HISTORY: usize = 20;
pub const MAX_OPEN_VERSUS: usize = 10;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct AppConfig {
    pub username: String,
    pub token: String,
    pub opacity: u8,
    pub versus_history: Vec<String>,
    pub theme: String,
    /// Minutes between automatic refreshes; 0 = manual only.
    pub refresh_interval: u32,
    pub launch_at_startup: bool,
    /// "normal" | "top" (always on top) | "bottom" (pinned to desktop)
    pub window_layer: String,
    pub lock_position: bool,
    pub show_stats: bool,
    pub show_quotes: bool,
    /// Daily contribution goal; 0 = disabled.
    pub daily_goal: u32,
    pub reminder_enabled: bool,
    /// Local hour (0-23) after which the streak reminder may fire.
    pub reminder_hour: u8,
    /// Global show/hide shortcut, e.g. "ctrl+alt+f"; empty = disabled.
    pub shortcut: String,
    /// Versus windows that were open on exit and get restored on launch.
    pub open_versus: Vec<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            username: String::new(),
            token: String::new(),
            opacity: 92,
            versus_history: Vec::new(),
            theme: "green".into(),
            refresh_interval: 60,
            launch_at_startup: true,
            window_layer: "normal".into(),
            lock_position: false,
            show_stats: true,
            show_quotes: true,
            daily_goal: 0,
            reminder_enabled: false,
            reminder_hour: 20,
            shortcut: "ctrl+alt+f".into(),
            open_versus: Vec::new(),
        }
    }
}

fn dedupe_users(list: &[String], limit: usize) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    list.iter()
        .map(|u| u.trim().trim_start_matches('@').to_string())
        .filter(|u| is_valid_username(u) && seen.insert(u.to_lowercase()))
        .take(limit)
        .collect()
}

impl AppConfig {
    /// Clamps every field into its valid range so the rest of the app never
    /// has to deal with a hand-edited or outdated config.
    pub fn sanitize(&mut self) {
        self.username = self.username.trim().trim_start_matches('@').to_string();
        if !self.username.is_empty() && !is_valid_username(&self.username) {
            self.username.clear();
        }
        self.token = self.token.trim().to_string();
        self.opacity = self.opacity.min(100);
        if !THEMES.contains(&self.theme.as_str()) {
            self.theme = "green".into();
        }
        if !WINDOW_LAYERS.contains(&self.window_layer.as_str()) {
            self.window_layer = "normal".into();
        }
        if self.refresh_interval != 0 {
            self.refresh_interval = self.refresh_interval.clamp(5, 24 * 60);
        }
        self.daily_goal = self.daily_goal.min(500);
        self.reminder_hour = self.reminder_hour.min(23);
        self.shortcut = self.shortcut.trim().to_lowercase();
        self.versus_history = dedupe_users(&self.versus_history, MAX_HISTORY);
        self.open_versus = dedupe_users(&self.open_versus, MAX_OPEN_VERSUS);
    }

    /// Minutes after which cached data is considered stale.
    pub fn cache_ttl_minutes(&self) -> i64 {
        if self.refresh_interval == 0 { 6 * 60 } else { self.refresh_interval as i64 }
    }

    pub fn is_main_user(&self, username: &str) -> bool {
        !self.username.is_empty() && self.username.eq_ignore_ascii_case(username)
    }
}

// ── Generic JSON IO ─────────────────────────────────────────────────────────

pub fn data_dir(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("github-contribution-widget"));
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

fn read_json<T: DeserializeOwned>(app: &AppHandle, name: &str) -> Option<T> {
    let content = fs::read_to_string(data_dir(app).join(name)).ok()?;
    serde_json::from_str(&content).ok()
}

fn write_json<T: Serialize>(app: &AppHandle, name: &str, value: &T, pretty: bool) -> Result<(), String> {
    let path = data_dir(app).join(name);
    let content = if pretty {
        serde_json::to_vec_pretty(value)
    } else {
        serde_json::to_vec(value)
    }
    .map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

// ── Config ──────────────────────────────────────────────────────────────────

pub fn read_config(app: &AppHandle) -> AppConfig {
    let mut config: AppConfig = read_json(app, "config.json").unwrap_or_default();
    config.sanitize();
    config
}

pub fn write_config(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    write_json(app, "config.json", config, true)
}

// ── Contribution caches ─────────────────────────────────────────────────────

fn cache_file(config: &AppConfig, username: &str) -> String {
    if config.is_main_user(username) {
        "data.json".into()
    } else {
        format!("versus_data_{}.json", username.to_lowercase())
    }
}

/// Reads the cached calendar for `username` (main user → data.json). Returns
/// None when the cache belongs to a different user (e.g. after a username change).
pub fn read_cache(app: &AppHandle, config: &AppConfig, username: &str) -> Option<CachedData> {
    if !is_valid_username(username) {
        return None;
    }
    let data: CachedData = read_json(app, &cache_file(config, username))?;
    let matches = data
        .username
        .as_deref()
        .map(|u| u.eq_ignore_ascii_case(username))
        .unwrap_or(false);
    (matches && !data.weeks.is_empty()).then_some(data)
}

pub fn write_cache(app: &AppHandle, config: &AppConfig, username: &str, data: &CachedData) -> Result<(), String> {
    if !is_valid_username(username) {
        return Err("invalid username".into());
    }
    write_json(app, &cache_file(config, username), data, false)
}

// ── Window positions ────────────────────────────────────────────────────────

/// Physical-pixel window position.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Pos {
    pub x: i32,
    pub y: i32,
}

#[derive(Deserialize)]
struct LegacyPosition {
    x: f64,
    y: f64,
}

pub enum SavedPosition {
    Physical(Pos),
    /// Pre-1.1 `position.json` stored logical coordinates of the main window.
    Logical(f64, f64),
}

pub fn read_positions(app: &AppHandle) -> HashMap<String, Pos> {
    read_json(app, "positions.json").unwrap_or_default()
}

pub fn write_positions(app: &AppHandle, positions: &HashMap<String, Pos>) -> Result<(), String> {
    write_json(app, "positions.json", positions, false)
}

pub fn saved_position(app: &AppHandle, positions: &HashMap<String, Pos>, label: &str) -> Option<SavedPosition> {
    if let Some(p) = positions.get(label) {
        return Some(SavedPosition::Physical(*p));
    }
    if label == "main" {
        let legacy: LegacyPosition = read_json(app, "position.json")?;
        return Some(SavedPosition::Logical(legacy.x, legacy.y));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_config_files_still_load() {
        let mut cfg: AppConfig = serde_json::from_str(
            r#"{"username":"octocat","token":"","opacity":80,"versus_history":["torvalds","bad name","Torvalds"]}"#,
        )
        .unwrap();
        cfg.sanitize();
        assert_eq!(cfg.username, "octocat");
        assert_eq!(cfg.opacity, 80);
        assert_eq!(cfg.versus_history, vec!["torvalds".to_string()]);
        assert_eq!(cfg.theme, "green");
        assert_eq!(cfg.refresh_interval, 60);
        assert_eq!(cfg.shortcut, "ctrl+alt+f");
    }

    #[test]
    fn sanitize_clamps_values() {
        let mut cfg = AppConfig {
            opacity: 250,
            theme: "nope".into(),
            window_layer: "sideways".into(),
            refresh_interval: 1,
            reminder_hour: 99,
            username: "../../etc".into(),
            ..AppConfig::default()
        };
        cfg.sanitize();
        assert_eq!(cfg.opacity, 100);
        assert_eq!(cfg.theme, "green");
        assert_eq!(cfg.window_layer, "normal");
        assert_eq!(cfg.refresh_interval, 5);
        assert_eq!(cfg.reminder_hour, 23);
        assert!(cfg.username.is_empty());
    }

    #[test]
    fn main_user_uses_primary_cache_file() {
        let cfg = AppConfig { username: "Octocat".into(), ..AppConfig::default() };
        assert_eq!(cache_file(&cfg, "octocat"), "data.json");
        assert_eq!(cache_file(&cfg, "Torvalds"), "versus_data_torvalds.json");
    }
}
