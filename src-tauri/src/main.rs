// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use tauri::{Manager, WebviewWindow, WebviewWindowBuilder, WebviewUrl, AppHandle, Emitter};
use tauri::menu::{Menu, MenuItem, CheckMenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use serde::{Serialize, Deserialize};
use chrono::Datelike;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Serialize, Deserialize, Clone, Debug)]
struct AppConfig {
    #[serde(default)]
    username: String,
    #[serde(default)]
    token: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct ContributionDay {
    date: String,
    count: i32,
    level: i32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct CachedData {
    weeks: Vec<Vec<ContributionDay>>,
    #[serde(rename = "lastFetched")]
    last_fetched: Option<String>,
    username: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct WindowPosition {
    x: f64,
    y: f64,
}

// ── File IO Helpers ────────────────────────────────────────────────────────

fn get_file_path(app_handle: &AppHandle, filename: &str) -> PathBuf {
    let mut path = app_handle.path().app_data_dir().unwrap_or_default();
    if !path.exists() {
        let _ = fs::create_dir_all(&path);
    }
    path.push(filename);
    path
}

fn read_config(app_handle: &AppHandle) -> AppConfig {
    let path = get_file_path(app_handle, "config.json");
    if let Ok(content) = fs::read_to_string(path) {
        if let Ok(config) = serde_json::from_str::<AppConfig>(&content) {
            return config;
        }
    }
    AppConfig { username: String::new(), token: String::new() }
}

fn write_config(app_handle: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = get_file_path(app_handle, "config.json");
    let content = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| e.to_string())
}

fn read_data(app_handle: &AppHandle) -> CachedData {
    let path = get_file_path(app_handle, "data.json");
    if let Ok(content) = fs::read_to_string(path) {
        if let Ok(data) = serde_json::from_str::<CachedData>(&content) {
            return data;
        }
    }
    CachedData { weeks: Vec::new(), last_fetched: None, username: None }
}

fn write_data(app_handle: &AppHandle, data: &CachedData) -> Result<(), String> {
    let path = get_file_path(app_handle, "data.json");
    let content = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| e.to_string())
}

fn read_position(app_handle: &AppHandle) -> Option<WindowPosition> {
    let path = get_file_path(app_handle, "position.json");
    if let Ok(content) = fs::read_to_string(path) {
        if let Ok(pos) = serde_json::from_str::<WindowPosition>(&content) {
            return Some(pos);
        }
    }
    None
}

fn write_position(app_handle: &AppHandle, x: f64, y: f64) -> Result<(), String> {
    let path = get_file_path(app_handle, "position.json");
    let pos = WindowPosition { x, y };
    let content = serde_json::to_string_pretty(&pos).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| e.to_string())
}

// ── GitHub Fetching & Parsing ───────────────────────────────────────────────

fn count_to_level(count: i32) -> i32 {
    if count == 0 { return 0; }
    if count <= 3 { return 1; }
    if count <= 6 { return 2; }
    if count <= 9 { return 3; }
    4
}

fn level_to_approx_count(level: i32) -> i32 {
    match level {
        0 => 0,
        1 => 1,
        2 => 4,
        3 => 7,
        4 => 10,
        _ => 0,
    }
}

fn group_days_into_weeks(days: Vec<ContributionDay>) -> Vec<Vec<ContributionDay>> {
    let mut weeks = Vec::new();
    let mut current_week = Vec::new();

    for day in days {
        let weekday = chrono::NaiveDate::parse_from_str(&day.date, "%Y-%m-%d")
            .map(|d| d.weekday())
            .unwrap_or(chrono::Weekday::Sun);

        if weekday == chrono::Weekday::Sun && !current_week.is_empty() {
            weeks.push(current_week);
            current_week = Vec::new();
        }
        current_week.push(day);
    }

    if !current_week.is_empty() {
        weeks.push(current_week);
    }

    weeks
}

async fn fetch_via_graphql(username: &str, token: &str) -> Result<Vec<Vec<ContributionDay>>, String> {
    let client = reqwest::Client::builder()
        .user_agent("GitHub Contribution Widget")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let query = r#"
        query ($username: String!) {
          user(login: $username) {
            contributionsCollection {
              contributionCalendar {
                weeks {
                  contributionDays {
                    contributionCount
                    date
                  }
                }
              }
            }
          }
        }
    "#;

    let variables = serde_json::json!({ "username": username });
    let body = serde_json::json!({ "query": query, "variables": variables });

    let response = client.post("https://api.github.com/graphql")
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("HTTP error! status: {}", response.status()));
    }

    let data: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    if let Some(errors) = data.get("errors") {
        if let Some(first_err) = errors.as_array().and_then(|a| a.first()) {
            if let Some(msg) = first_err.get("message").and_then(|m| m.as_str()) {
                return Err(msg.to_string());
            }
        }
        return Err("GraphQL error".to_string());
    }

    let weeks_val = data.pointer("/data/user/contributionsCollection/contributionCalendar/weeks")
        .and_then(|w| w.as_array())
        .ok_or("Failed to parse GraphQL response structure")?;

    let mut weeks = Vec::new();
    for week in weeks_val {
        let mut days = Vec::new();
        if let Some(days_val) = week.get("contributionDays").and_then(|d| d.as_array()) {
            for day in days_val {
                let date = day.get("date").and_then(|d| d.as_str()).unwrap_or_default().to_string();
                let count = day.get("contributionCount").and_then(|c| c.as_i64()).unwrap_or(0) as i32;
                let level = count_to_level(count);
                days.push(ContributionDay { date, count, level });
            }
        }
        weeks.push(days);
    }

    Ok(weeks)
}

async fn fetch_via_scraping(username: &str) -> Result<Vec<Vec<ContributionDay>>, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("https://github.com/users/{}/contributions", username);
    let response = client.get(&url).send().await.map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("HTTP error! status: {}", response.status()));
    }

    let html = response.text().await.map_err(|e| e.to_string())?;

    // Parse tooltips first
    let tooltip_re = regex::Regex::new(r#"<tool-tip[^>]*>(\d+)\s+contribution"#).map_err(|e| e.to_string())?;
    let mut counts = Vec::new();
    for cap in tooltip_re.captures_iter(&html) {
        if let Some(c_str) = cap.get(1) {
            if let Ok(c) = c_str.as_str().parse::<i32>() {
                counts.push(c);
            }
        }
    }

    // Parse td cells
    let td_re = regex::Regex::new(r#"<td[^>]*data-date="([^"]*)"[^>]*data-level="(\d)"[^>]*>"#).map_err(|e| e.to_string())?;
    let mut days = Vec::new();
    let mut idx = 0;
    for cap in td_re.captures_iter(&html) {
        let date = cap.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
        let level = cap.get(2).and_then(|m| m.as_str().parse::<i32>().ok()).unwrap_or(0);
        let count = if idx < counts.len() { counts[idx] } else { level_to_approx_count(level) };
        days.push(ContributionDay { date, count, level });
        idx += 1;
    }

    days.sort_by(|a, b| a.date.cmp(&b.date));
    let mut weeks = group_days_into_weeks(days);

    if weeks.is_empty() {
        weeks = fetch_via_contrib_page(username).await?;
    }

    Ok(weeks)
}

async fn fetch_via_contrib_page(username: &str) -> Result<Vec<Vec<ContributionDay>>, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("https://github.com/{}", username);
    let response = client.get(&url).send().await.map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("HTTP error! status: {}", response.status()));
    }

    let html = response.text().await.map_err(|e| e.to_string())?;
    let cell_re = regex::Regex::new(r#"data-date="(\d{4}-\d{2}-\d{2})"[^>]*data-level="(\d)""#).map_err(|e| e.to_string())?;

    let mut days = Vec::new();
    for cap in cell_re.captures_iter(&html) {
        let date = cap.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
        let level = cap.get(2).and_then(|m| m.as_str().parse::<i32>().ok()).unwrap_or(0);
        days.push(ContributionDay {
            date,
            count: level_to_approx_count(level),
            level,
        });
    }

    days.sort_by(|a, b| a.date.cmp(&b.date));
    let weeks = group_days_into_weeks(days);

    if weeks.is_empty() {
        return Err(format!("Could not fetch contributions for \"{}\". Check the username or provide a personal access token.", username));
    }

    Ok(weeks)
}

async fn do_fetch_contributions(username: &str, token: &str) -> Result<Vec<Vec<ContributionDay>>, String> {
    if !token.is_empty() {
        match fetch_via_graphql(username, token).await {
            Ok(w) => return Ok(w),
            Err(e) => {
                println!("GraphQL fetch failed, falling back to scraping: {}", e);
            }
        }
    }
    fetch_via_scraping(username).await
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command]
fn get_data(app_handle: AppHandle) -> CachedData {
    read_data(&app_handle)
}

#[tauri::command]
fn get_config(app_handle: AppHandle) -> AppConfig {
    read_config(&app_handle)
}

#[tauri::command]
fn save_config(app_handle: AppHandle, config: AppConfig) -> Result<(), String> {
    write_config(&app_handle, &config)
}

#[tauri::command]
async fn fetch_contributions(app_handle: AppHandle) -> Result<CachedData, String> {
    let config = read_config(&app_handle);
    if config.username.is_empty() {
        return Err("No username configured".to_string());
    }

    let weeks = do_fetch_contributions(&config.username, &config.token).await?;
    let data = CachedData {
        weeks,
        last_fetched: Some(chrono::Utc::now().to_rfc3339()),
        username: Some(config.username),
    };
    write_data(&app_handle, &data)?;
    Ok(data)
}

#[tauri::command]
async fn fetch_user_contributions(app_handle: AppHandle, username: String) -> Result<CachedData, String> {
    let config = read_config(&app_handle);
    let weeks = do_fetch_contributions(&username, &config.token).await?;
    let data = CachedData {
        weeks,
        last_fetched: Some(chrono::Utc::now().to_rfc3339()),
        username: Some(username),
    };
    Ok(data)
}

#[tauri::command]
async fn open_versus_window(app_handle: AppHandle, username: String) -> Result<(), String> {
    let label = format!("versus_{}", username);

    // If the versus window is already open, just bring it to front focus
    if let Some(existing_win) = app_handle.get_webview_window(&label) {
        let _ = existing_win.set_focus();
        return Ok(());
    }

    // Count existing versus windows for cascading position
    let versus_count = app_handle.webview_windows()
        .keys()
        .filter(|k| k.starts_with("versus_"))
        .count();

    let mut pos_x = None;
    let mut pos_y = None;
    if let Some(main_win) = app_handle.get_webview_window("main") {
        if let Ok(p) = main_win.outer_position() {
            let scale_factor = main_win.scale_factor().unwrap_or(1.0);
            let logical = p.to_logical::<f64>(scale_factor);
            pos_x = Some(logical.x);
            pos_y = Some(logical.y);
        }
    }

    let (x, y) = if let (Some(mx), Some(my)) = (pos_x, pos_y) {
        let slot_height = 250.0; // 240px window + 10px gap
        let slot_width = 890.0;  // 880px window + 10px gap

        // Calculate how many versus windows can stack vertically above main
        let max_rows = (my / slot_height).floor().max(1.0) as usize;

        let col = versus_count / max_rows;
        let row = versus_count % max_rows;

        let target_x = mx - (col as f64 * slot_width);
        let target_y = my - ((row + 1) as f64 * slot_height);

        // If we'd go off-screen left, cascade with small offsets instead
        if target_x < 0.0 {
            let cascade = versus_count as f64;
            (mx + 30.0 * cascade, (my - 250.0 + 30.0 * cascade).max(0.0))
        } else {
            (target_x, target_y.max(0.0))
        }
    } else {
        if let Some(monitor) = app_handle.primary_monitor().ok().flatten() {
            let scale_factor = monitor.scale_factor();
            let size = monitor.size().to_logical::<f64>(scale_factor);
            (size.width - 880.0 - 30.0, size.height - 480.0 - 40.0)
        } else {
            (300.0, 300.0)
        }
    };

    let vs_win = WebviewWindowBuilder::new(&app_handle, &label, WebviewUrl::App("index.html".into()))
        .title(format!("GitHub Versus - {}", username))
        .inner_size(880.0, 240.0)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .skip_taskbar(true)
        .shadow(false)
        .build()
        .map_err(|e| e.to_string())?;

    let _ = vs_win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
    let _ = vs_win.show();
    let _ = vs_win.set_focus();

    Ok(())
}

#[tauri::command]
fn close_all_versus(app_handle: AppHandle) {
    let labels: Vec<String> = app_handle.webview_windows()
        .keys()
        .filter(|k| k.starts_with("versus_"))
        .cloned()
        .collect();

    for label in labels {
        if let Some(win) = app_handle.get_webview_window(&label) {
            let _ = win.close();
        }
    }
}

#[tauri::command]
fn close_app(app_handle: AppHandle) {
    app_handle.cleanup_before_exit();
    std::process::exit(0);
}

#[tauri::command]
fn minimize_to_tray(window: WebviewWindow) {
    if window.label() == "main" {
        let _ = window.hide();
    } else {
        let _ = window.close();
    }
}

// ── Auto-Start (Windows Registry) ─────────────────────────────────────────

#[cfg(target_os = "windows")]
fn setup_auto_start() {
    if let Ok(exe_path) = std::env::current_exe() {
        let exe_path_str = exe_path.to_string_lossy().to_string();
        let cmd = format!(
            "Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'GitHubContributionWidget' -Value '\"{}\"'",
            exe_path_str
        );

        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("powershell")
            .arg("-Command")
            .arg(&cmd)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output();
    }
}

#[cfg(not(target_os = "windows"))]
fn setup_auto_start() {}

// ── Main Entry Point ────────────────────────────────────────────────────────

fn main() {
    setup_auto_start();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app_handle, shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                let shortcut_str = shortcut.to_string();
                if shortcut_str == "ctrl+g" {
                    if let Some(win) = app_handle.get_webview_window("main") {
                        let is_visible = win.is_visible().unwrap_or(true);
                        if is_visible {
                            let _ = win.hide();
                        } else {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                } else if shortcut_str == "ctrl+alt+g" {
                    if let Some(win) = app_handle.get_webview_window("main") {
                        if !win.is_visible().unwrap_or(false) {
                            let _ = win.show();
                        }
                        let _ = win.set_focus();
                    }
                }
            }
        }).build())
        .setup(|app| {
            // Set up main window position caching & loading
            let main_window = app.get_webview_window("main").unwrap();

            if let Some(pos) = read_position(app.handle()) {
                let _ = main_window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(pos.x, pos.y)));
            } else {
                if let Some(monitor) = app.primary_monitor().ok().flatten() {
                    let scale_factor = monitor.scale_factor();
                    let size = monitor.size().to_logical::<f64>(scale_factor);
                    let x = size.width - 880.0 - 30.0;
                    let y = size.height - 240.0 - 30.0;
                    let _ = main_window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
                }
            }

            let app_handle_clone = app.handle().clone();
            let main_window_clone = main_window.clone();
            main_window.on_window_event(move |event| {
                if let tauri::WindowEvent::Moved(pos) = event {
                    let scale_factor = main_window_clone.scale_factor().unwrap_or(1.0);
                    let logical = pos.to_logical::<f64>(scale_factor);
                    let _ = write_position(&app_handle_clone, logical.x, logical.y);
                }
            });

            // ── System Tray ──
            let show_hide = MenuItem::with_id(app, "show_hide", "Show/Hide Widget", true, None::<&str>)?;
            let toggle_click_through = CheckMenuItem::with_id(app, "toggle_click_through", "Toggle Click-Through", true, false, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "Refresh Data", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let tray_menu = Menu::new(app)?;
            let _ = tray_menu.append(&show_hide);
            let _ = tray_menu.append(&toggle_click_through);
            let _ = tray_menu.append(&tauri::menu::PredefinedMenuItem::separator(app)?);
            let _ = tray_menu.append(&refresh);
            let _ = tray_menu.append(&tauri::menu::PredefinedMenuItem::separator(app)?);
            let _ = tray_menu.append(&quit);

            let toggle_click_through_clone = toggle_click_through.clone();
            let default_icon = app.default_window_icon().cloned();
            let mut tray_builder = TrayIconBuilder::new();
            if let Some(icon) = default_icon {
                tray_builder = tray_builder.icon(icon);
            } else {
                let mut rgba_data = vec![0u8; 16 * 16 * 4];
                for i in 0..(16 * 16) {
                    rgba_data[i * 4] = 35;     // R
                    rgba_data[i * 4 + 1] = 134; // G
                    rgba_data[i * 4 + 2] = 54;  // B
                    rgba_data[i * 4 + 3] = 255; // A
                }
                let icon = tauri::image::Image::new_owned(rgba_data, 16, 16);
                tray_builder = tray_builder.icon(icon);
            }

            let _tray = tray_builder
                .menu(&tray_menu)
                .on_menu_event(move |app_handle, event| {
                    match event.id.as_ref() {
                        "show_hide" => {
                            if let Some(win) = app_handle.get_webview_window("main") {
                                let is_visible = win.is_visible().unwrap_or(true);
                                if is_visible {
                                    let _ = win.hide();
                                } else {
                                    let _ = win.show();
                                    let _ = win.set_focus();
                                }
                            }
                        }
                        "toggle_click_through" => {
                            if let Some(win) = app_handle.get_webview_window("main") {
                                if let Ok(checked) = toggle_click_through_clone.is_checked() {
                                    let _ = win.set_ignore_cursor_events(checked);
                                    let _ = win.emit("click-through-changed", checked);
                                }
                            }
                        }
                        "refresh" => {
                            if let Some(win) = app_handle.get_webview_window("main") {
                                let _ = win.emit("trigger-refresh", ());
                            }
                        }
                        "quit" => {
                            app_handle.cleanup_before_exit();
                            std::process::exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } = event {
                        let app_handle = tray.app_handle();
                        if let Some(win) = app_handle.get_webview_window("main") {
                            let is_visible = win.is_visible().unwrap_or(true);
                            if is_visible {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // Register global shortcuts
            use std::str::FromStr;
            if let Ok(ctrl_g) = Shortcut::from_str("ctrl+g") {
                let _ = app.handle().global_shortcut().register(ctrl_g);
            }
            if let Ok(ctrl_alt_g) = Shortcut::from_str("ctrl+alt+g") {
                let _ = app.handle().global_shortcut().register(ctrl_alt_g);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_data,
            get_config,
            save_config,
            fetch_contributions,
            fetch_user_contributions,
            open_versus_window,
            close_all_versus,
            close_app,
            minimize_to_tray
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
