// Prevents additional console window on Windows in both debug and release
#![windows_subsystem = "windows"]

mod autostart;
mod github;
mod storage;

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use chrono::{Local, NaiveDate, Timelike};
use serde::Serialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Position, RunEvent, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

use github::{validate_username, CachedData};
use storage::{AppConfig, Pos, SavedPosition};

const MAIN_LABEL: &str = "main";
const VERSUS_PREFIX: &str = "versus_";
const TRAY_ID: &str = "main-tray";
const WIDGET_WIDTH: f64 = 868.0;
const WIDGET_HEIGHT: f64 = 250.0;
/// Data refreshed this recently is reused even for forced refreshes, so double
/// clicks or overlapping refreshes don't hit GitHub twice.
const MIN_REFETCH_SECS: i64 = 15;
/// After a failed fetch the background loop waits this long before retrying.
const FAILURE_BACKOFF: Duration = Duration::from_secs(5 * 60);

// ── Shared state ────────────────────────────────────────────────────────────

struct TrayItems {
    on_top: CheckMenuItem<Wry>,
    pin_desktop: CheckMenuItem<Wry>,
    lock: CheckMenuItem<Wry>,
    click_through: CheckMenuItem<Wry>,
}

struct AppState {
    config: Mutex<AppConfig>,
    http: reqwest::Client,
    /// Caps concurrent requests to GitHub.
    http_permits: Semaphore,
    /// One lock per username so concurrent callers share a single fetch.
    user_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    failed_at: Mutex<HashMap<String, Instant>>,
    positions: Mutex<HashMap<String, Pos>>,
    positions_gen: AtomicU64,
    click_through: AtomicBool,
    refreshing: AtomicBool,
    last_reminder: Mutex<Option<NaiveDate>>,
    last_goal: Mutex<Option<NaiveDate>>,
    shortcut: Mutex<Option<Shortcut>>,
    tray_items: Mutex<Option<TrayItems>>,
}

impl AppState {
    fn user_lock(&self, username: &str) -> Arc<AsyncMutex<()>> {
        self.user_locks
            .lock()
            .unwrap()
            .entry(username.to_lowercase())
            .or_default()
            .clone()
    }
}

fn config(app: &AppHandle) -> AppConfig {
    app.state::<AppState>().config.lock().unwrap().clone()
}

/// Applies `change` to the config, persists it and notifies every window.
fn mutate_config(app: &AppHandle, change: impl FnOnce(&mut AppConfig)) -> Result<AppConfig, String> {
    let state = app.state::<AppState>();
    let (old, new) = {
        let mut guard = state.config.lock().unwrap();
        let old = guard.clone();
        change(&mut guard);
        guard.sanitize();
        (old, guard.clone())
    };
    if old != new {
        storage::write_config(app, &new)?;
        apply_config_side_effects(app, &old, &new);
        let _ = app.emit("config-changed", &new);
    }
    Ok(new)
}

fn apply_config_side_effects(app: &AppHandle, old: &AppConfig, new: &AppConfig) {
    if old.launch_at_startup != new.launch_at_startup {
        if let Err(e) = autostart::set_enabled(new.launch_at_startup) {
            eprintln!("autostart update failed: {}", e);
        }
    }
    if old.window_layer != new.window_layer {
        for win in widget_windows(app) {
            apply_window_layer(&win, &new.window_layer);
        }
    }
    if !old.username.eq_ignore_ascii_case(&new.username) {
        app.state::<AppState>().failed_at.lock().unwrap().clear();
        update_tray_tooltip(app, None);
    }
    sync_tray_checks(app, new);
}

// ── Payloads ────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct DataUpdated<'a> {
    username: &'a str,
    data: &'a CachedData,
}

#[derive(Serialize, Default)]
struct RefreshSummary {
    refreshed: u32,
    failed: Vec<String>,
}

// ── Data loading ────────────────────────────────────────────────────────────

fn cache_age_secs(data: &CachedData) -> i64 {
    data.last_fetched
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_seconds())
        .unwrap_or(i64::MAX)
}

/// Returns contributions for `username`, served from cache while fresh.
/// `force` bypasses the cache TTL (but not the 15 s de-duplication window).
/// A non-forced load falls back to stale cache if GitHub can't be reached.
async fn load_user(app: &AppHandle, username: &str, force: bool) -> Result<CachedData, String> {
    let state = app.state::<AppState>();
    let lock = state.user_lock(username);
    let _guard = lock.lock().await;

    let cfg = config(app);
    let cached = storage::read_cache(app, &cfg, username);
    if let Some(c) = &cached {
        let age = cache_age_secs(c);
        if age < MIN_REFETCH_SECS || (!force && age < cfg.cache_ttl_minutes() * 60) {
            return Ok(c.clone());
        }
    }

    let result = {
        let _permit = state.http_permits.acquire().await.map_err(|e| e.to_string())?;
        github::fetch_contributions(&state.http, username, &cfg.token).await
    };

    match result {
        Ok(weeks) => {
            state.failed_at.lock().unwrap().remove(&username.to_lowercase());
            let data = CachedData {
                weeks,
                last_fetched: Some(chrono::Utc::now().to_rfc3339()),
                username: Some(username.to_string()),
            };
            // Re-read: the username may have changed while we were fetching.
            let cfg = config(app);
            if let Err(e) = storage::write_cache(app, &cfg, username, &data) {
                eprintln!("failed to write cache for {}: {}", username, e);
            }
            if cfg.is_main_user(username) {
                on_main_data_updated(app, &cfg, cached.as_ref(), &data);
            }
            let _ = app.emit("data-updated", DataUpdated { username, data: &data });
            Ok(data)
        }
        Err(e) => {
            state.failed_at.lock().unwrap().insert(username.to_lowercase(), Instant::now());
            match cached {
                Some(c) if !force => Ok(c),
                _ => Err(e),
            }
        }
    }
}

fn on_main_data_updated(app: &AppHandle, cfg: &AppConfig, old: Option<&CachedData>, new: &CachedData) {
    let today = Local::now().date_naive();
    let summary = github::summarize(&new.weeks, today);
    update_tray_tooltip(app, Some((&cfg.username, &summary)));

    if cfg.daily_goal == 0 || summary.today_count < cfg.daily_goal as i32 {
        return;
    }
    let previous = old.map(|o| github::summarize(&o.weeks, today).today_count).unwrap_or(0);
    let state = app.state::<AppState>();
    let mut last_goal = state.last_goal.lock().unwrap();
    if previous < cfg.daily_goal as i32 && *last_goal != Some(today) {
        *last_goal = Some(today);
        notify(
            app,
            "🎯 Daily goal reached!",
            &format!(
                "{} contributions today (goal: {}). Current streak: {} days.",
                summary.today_count, cfg.daily_goal, summary.current_streak
            ),
        );
    }
}

async fn refresh_everything(app: &AppHandle) -> Result<RefreshSummary, String> {
    let state = app.state::<AppState>();
    if state.refreshing.swap(true, Ordering::SeqCst) {
        return Err("A refresh is already running".into());
    }
    let _ = app.emit("refresh-state", true);

    let cfg = config(app);
    let mut seen = std::collections::HashSet::new();
    let users: Vec<String> = std::iter::once(cfg.username.clone())
        .chain(cfg.versus_history.iter().cloned())
        .chain(cfg.open_versus.iter().cloned())
        .filter(|u| !u.is_empty() && seen.insert(u.to_lowercase()))
        .collect();

    let handles: Vec<_> = users
        .into_iter()
        .map(|user| {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let result = load_user(&app, &user, true).await;
                (user, result)
            })
        })
        .collect();

    let mut summary = RefreshSummary::default();
    for handle in handles {
        match handle.await {
            Ok((_, Ok(_))) => summary.refreshed += 1,
            Ok((user, Err(e))) => summary.failed.push(format!("{}: {}", user, e)),
            Err(e) => summary.failed.push(e.to_string()),
        }
    }

    state.refreshing.store(false, Ordering::SeqCst);
    let _ = app.emit("refresh-state", false);
    Ok(summary)
}

// ── Background loop: auto-refresh + streak reminder ─────────────────────────

fn recently_failed(app: &AppHandle, username: &str) -> bool {
    app.state::<AppState>()
        .failed_at
        .lock()
        .unwrap()
        .get(&username.to_lowercase())
        .map(|t| t.elapsed() < FAILURE_BACKOFF)
        .unwrap_or(false)
}

fn is_stale(app: &AppHandle, cfg: &AppConfig, username: &str, max_age_secs: i64) -> bool {
    storage::read_cache(app, cfg, username)
        .map(|c| cache_age_secs(&c) >= max_age_secs)
        .unwrap_or(true)
}

async fn background_tick(app: &AppHandle) {
    let cfg = config(app);
    if cfg.username.is_empty() {
        return;
    }

    if cfg.refresh_interval > 0 {
        let max_age = cfg.refresh_interval as i64 * 60;
        let mut users = vec![cfg.username.clone()];
        users.extend(versus_windows(app).into_iter().filter_map(|w| versus_user(&w)));
        for user in users {
            if is_stale(app, &cfg, &user, max_age) && !recently_failed(app, &user) {
                let _ = load_user(app, &user, true).await;
            }
        }
    }

    check_streak_reminder(app, &cfg).await;
}

async fn check_streak_reminder(app: &AppHandle, cfg: &AppConfig) {
    let now = Local::now();
    let today = now.date_naive();
    if !cfg.reminder_enabled || now.hour() < cfg.reminder_hour as u32 {
        return;
    }
    if *app.state::<AppState>().last_reminder.lock().unwrap() == Some(today) {
        return;
    }
    // Make sure we're judging today's activity on fresh data.
    if is_stale(app, cfg, &cfg.username, 15 * 60) {
        if recently_failed(app, &cfg.username) {
            return;
        }
        if load_user(app, &cfg.username, true).await.is_err() {
            return;
        }
    }
    let Some(data) = storage::read_cache(app, cfg, &cfg.username) else { return };
    *app.state::<AppState>().last_reminder.lock().unwrap() = Some(today);

    let summary = github::summarize(&data.weeks, today);
    if summary.today_count > 0 {
        return;
    }
    let body = if summary.current_streak > 0 {
        format!(
            "Your {}-day streak ends at midnight. One contribution keeps it alive!",
            summary.current_streak
        )
    } else {
        "No contributions yet today — a small commit keeps the graph green.".to_string()
    };
    notify(app, "🔥 Streak at risk", &body);
}

fn spawn_background_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        loop {
            background_tick(&app).await;
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        eprintln!("notification failed: {}", e);
    }
}

// ── Windows ─────────────────────────────────────────────────────────────────

fn widget_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows().into_values().collect()
}

fn versus_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with(VERSUS_PREFIX))
        .map(|(_, w)| w)
        .collect()
}

fn versus_label(username: &str) -> String {
    format!("{}{}", VERSUS_PREFIX, username.to_lowercase())
}

fn versus_user(win: &WebviewWindow) -> Option<String> {
    win.label().strip_prefix(VERSUS_PREFIX).map(|s| s.to_string())
}

fn apply_window_layer(win: &WebviewWindow, layer: &str) {
    let (top, bottom) = match layer {
        "top" => (true, false),
        "bottom" => (false, true),
        _ => (false, false),
    };
    // Clear the opposite flag first so the two never fight.
    if top {
        let _ = win.set_always_on_bottom(false);
        let _ = win.set_always_on_top(true);
    } else {
        let _ = win.set_always_on_top(false);
        let _ = win.set_always_on_bottom(bottom);
    }
}

fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(MAIN_LABEL) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn toggle_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(MAIN_LABEL) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            show_main(app);
        }
    }
}

/// True when a reasonable part of the window's top strip lies on a monitor,
/// i.e. the user can still see and drag it.
fn is_on_screen(app: &AppHandle, win: &WebviewWindow) -> bool {
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else { return true };
    let Ok(monitors) = app.available_monitors() else { return true };
    let (wx0, wy0) = (pos.x as i64, pos.y as i64);
    let (wx1, wy1) = (wx0 + size.width as i64, wy0 + 40);
    monitors.iter().any(|m| {
        let (mx0, my0) = (m.position().x as i64, m.position().y as i64);
        let (mx1, my1) = (mx0 + m.size().width as i64, my0 + m.size().height as i64);
        let overlap_w = wx1.min(mx1) - wx0.max(mx0);
        let overlap_h = wy1.min(my1) - wy0.max(my0);
        overlap_w >= 120 && overlap_h >= 20
    })
}

/// Bottom-right corner of the primary monitor's work area, stepped up by `slot`
/// window heights so several widgets don't stack on top of each other.
fn default_position(app: &AppHandle, win: &WebviewWindow, slot: u32) -> Option<PhysicalPosition<i32>> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let area = monitor.work_area();
    let size = win.outer_size().ok()?;
    let margin = (24.0 * monitor.scale_factor()) as i32;
    let x = area.position.x + area.size.width as i32 - size.width as i32 - margin;
    let y = area.position.y + area.size.height as i32
        - (size.height as i32 + margin / 2) * (slot as i32 + 1)
        - margin / 2;
    Some(PhysicalPosition::new(x.max(area.position.x), y.max(area.position.y)))
}

fn place_window(app: &AppHandle, win: &WebviewWindow, fallback_slot: u32) {
    let state = app.state::<AppState>();
    let saved = {
        let positions = state.positions.lock().unwrap();
        storage::saved_position(app, &positions, win.label())
    };
    match saved {
        Some(SavedPosition::Physical(p)) => {
            let _ = win.set_position(Position::Physical(PhysicalPosition::new(p.x, p.y)));
        }
        Some(SavedPosition::Logical(x, y)) => {
            let _ = win.set_position(Position::Logical(tauri::LogicalPosition::new(x, y)));
        }
        None => {}
    }
    if saved.is_none() || !is_on_screen(app, win) {
        if let Some(p) = default_position(app, win, fallback_slot) {
            let _ = win.set_position(Position::Physical(p));
        }
    }
}

fn remember_position(app: &AppHandle, label: &str, pos: PhysicalPosition<i32>) {
    // Windows reports (-32000, -32000) for minimized windows.
    if pos.x <= -30000 || pos.y <= -30000 {
        return;
    }
    let state = app.state::<AppState>();
    state.positions.lock().unwrap().insert(label.to_string(), Pos { x: pos.x, y: pos.y });
    let generation = state.positions_gen.fetch_add(1, Ordering::SeqCst) + 1;

    // Debounce: dragging fires dozens of Moved events per second; only the
    // final resting position is written to disk.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(600)).await;
        let state = app.state::<AppState>();
        if state.positions_gen.load(Ordering::SeqCst) == generation {
            let snapshot = state.positions.lock().unwrap().clone();
            let _ = storage::write_positions(&app, &snapshot);
        }
    });
}

fn attach_window_events(app: &AppHandle, win: &WebviewWindow) {
    let app = app.clone();
    let label = win.label().to_string();
    let handle = win.clone();
    win.on_window_event(move |event| match event {
        WindowEvent::Moved(pos) => remember_position(&app, &label, *pos),
        WindowEvent::CloseRequested { api, .. } if label == MAIN_LABEL => {
            // Alt+F4 on the widget hides it to the tray instead of destroying it.
            api.prevent_close();
            let _ = handle.hide();
        }
        _ => {}
    });
}

fn create_versus_window(app: &AppHandle, username: &str) -> Result<(), String> {
    let label = versus_label(username);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let slot = versus_windows(app).len() as u32 + 1;
    let init_script = format!(
        "window.__VERSUS_USER__ = {};",
        serde_json::to_string(username).map_err(|e| e.to_string())?
    );
    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(format!("GitHub Versus - {}", username))
        .inner_size(WIDGET_WIDTH, WIDGET_HEIGHT)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .initialization_script(init_script)
        .build()
        .map_err(|e| e.to_string())?;

    place_window(app, &win, slot);
    apply_window_layer(&win, &config(app).window_layer);
    if app.state::<AppState>().click_through.load(Ordering::SeqCst) {
        let _ = win.set_ignore_cursor_events(true);
    }
    attach_window_events(app, &win);
    let _ = win.show();
    Ok(())
}

// ── Global shortcut ─────────────────────────────────────────────────────────

/// Swaps the registered global shortcut. The new one is registered before the
/// old one is released, so a failure leaves the previous shortcut working.
fn apply_shortcut(app: &AppHandle, spec: &str) -> Result<(), String> {
    let next = if spec.is_empty() {
        None
    } else {
        Some(Shortcut::from_str(spec).map_err(|e| format!("Invalid shortcut \"{}\": {}", spec, e))?)
    };
    let state = app.state::<AppState>();
    let mut current = state.shortcut.lock().unwrap();
    if *current == next {
        return Ok(());
    }
    let manager = app.global_shortcut();
    if let Some(sc) = next {
        manager
            .register(sc)
            .map_err(|e| format!("Couldn't register \"{}\" — it may be in use by another app ({})", spec, e))?;
    }
    if let Some(old) = current.take() {
        let _ = manager.unregister(old);
    }
    *current = next;
    Ok(())
}

// ── Tray ────────────────────────────────────────────────────────────────────

fn update_tray_tooltip(app: &AppHandle, info: Option<(&str, &github::Summary)>) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let text = match info {
        Some((user, s)) => format!(
            "{} · {} contributions this year\n🔥 {}-day streak · {} today",
            user, s.total, s.current_streak, s.today_count
        ),
        None => "GitHub Contribution Widget".to_string(),
    };
    let _ = tray.set_tooltip(Some(text));
}

fn sync_tray_checks(app: &AppHandle, cfg: &AppConfig) {
    let state = app.state::<AppState>();
    let click_through = state.click_through.load(Ordering::SeqCst);
    let items = state.tray_items.lock().unwrap();
    if let Some(items) = items.as_ref() {
        let _ = items.on_top.set_checked(cfg.window_layer == "top");
        let _ = items.pin_desktop.set_checked(cfg.window_layer == "bottom");
        let _ = items.lock.set_checked(cfg.lock_position);
        let _ = items.click_through.set_checked(click_through);
    }
}

fn set_click_through(app: &AppHandle, enabled: bool) {
    app.state::<AppState>().click_through.store(enabled, Ordering::SeqCst);
    for win in widget_windows(app) {
        let _ = win.set_ignore_cursor_events(enabled);
    }
    let _ = app.emit("click-through-changed", enabled);
    sync_tray_checks(app, &config(app));
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let cfg = config(app);
    let show_hide = MenuItem::with_id(app, "show_hide", "Show / Hide Widget", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh Now", true, None::<&str>)?;
    let profile = MenuItem::with_id(app, "open_profile", "Open GitHub Profile", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let on_top = CheckMenuItem::with_id(app, "on_top", "Always on Top", true, cfg.window_layer == "top", None::<&str>)?;
    let pin_desktop =
        CheckMenuItem::with_id(app, "pin_desktop", "Pin to Desktop", true, cfg.window_layer == "bottom", None::<&str>)?;
    let lock = CheckMenuItem::with_id(app, "lock", "Lock Position", true, cfg.lock_position, None::<&str>)?;
    let click_through = CheckMenuItem::with_id(app, "click_through", "Click-Through", true, false, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show_hide,
            &refresh,
            &PredefinedMenuItem::separator(app)?,
            &profile,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &on_top,
            &pin_desktop,
            &lock,
            &click_through,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    *app.state::<AppState>().tray_items.lock().unwrap() =
        Some(TrayItems { on_top, pin_desktop, lock, click_through });

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("GitHub Contribution Widget")
        .menu(&menu)
        .show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    } else {
        let rgba: Vec<u8> = std::iter::repeat([35u8, 134, 54, 255]).take(16 * 16).flatten().collect();
        builder = builder.icon(tauri::image::Image::new_owned(rgba, 16, 16));
    }

    builder
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show_hide" => toggle_main(app),
            "refresh" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = refresh_everything(&app).await;
                });
            }
            "open_profile" => {
                let user = config(app).username;
                let url = if user.is_empty() { "https://github.com".to_string() } else { format!("https://github.com/{}", user) };
                let _ = app.opener().open_url(url, None::<&str>);
            }
            "settings" => {
                show_main(app);
                let _ = app.emit_to(MAIN_LABEL, "open-settings", ());
            }
            "on_top" | "pin_desktop" => {
                let target = if event.id.as_ref() == "on_top" { "top" } else { "bottom" };
                let _ = mutate_config(app, |c| {
                    c.window_layer = if c.window_layer == target { "normal".into() } else { target.into() };
                });
                // Re-sync in case the menu auto-toggled a check we didn't change.
                sync_tray_checks(app, &config(app));
            }
            "lock" => {
                let _ = mutate_config(app, |c| c.lock_position = !c.lock_position);
                sync_tray_checks(app, &config(app));
            }
            "click_through" => {
                let enabled = !app.state::<AppState>().click_through.load(Ordering::SeqCst);
                set_click_through(app, enabled);
            }
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Click fires for both button-down and button-up; act once.
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn quit(app: &AppHandle) {
    let state = app.state::<AppState>();
    let snapshot = state.positions.lock().unwrap().clone();
    let _ = storage::write_positions(app, &snapshot);
    app.exit(0);
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_config(app: AppHandle) -> AppConfig {
    config(&app)
}

/// Merges a partial config into the current one. Only known keys are taken,
/// so callers can't wipe unrelated settings by omitting them.
#[tauri::command]
fn update_config(app: AppHandle, patch: serde_json::Value) -> Result<AppConfig, String> {
    let patch = patch.as_object().ok_or("Settings must be an object")?;
    if let Some(user) = patch.get("username").and_then(|u| u.as_str()) {
        if !user.trim().is_empty() {
            validate_username(user)?;
        }
    }

    let current = config(&app);
    let mut merged = serde_json::to_value(&current).map_err(|e| e.to_string())?;
    let obj = merged.as_object_mut().ok_or("internal config error")?;
    for (key, value) in patch {
        if obj.contains_key(key) {
            obj.insert(key.clone(), value.clone());
        }
    }
    let mut next: AppConfig = serde_json::from_value(merged).map_err(|e| format!("Invalid settings: {}", e))?;
    next.sanitize();

    if next.shortcut != current.shortcut {
        apply_shortcut(&app, &next.shortcut)?;
    }
    mutate_config(&app, |c| *c = next)
}

#[tauri::command]
fn get_data(app: AppHandle, username: Option<String>) -> Option<CachedData> {
    let cfg = config(&app);
    let user = username.unwrap_or_else(|| cfg.username.clone());
    storage::read_cache(&app, &cfg, &user)
}

#[tauri::command]
async fn fetch_contributions(app: AppHandle, force: Option<bool>) -> Result<CachedData, String> {
    let user = config(&app).username;
    if user.is_empty() {
        return Err("No username configured".into());
    }
    load_user(&app, &user, force.unwrap_or(true)).await
}

#[tauri::command]
async fn fetch_user_contributions(app: AppHandle, username: String, force: Option<bool>) -> Result<CachedData, String> {
    let username = validate_username(&username)?;
    load_user(&app, &username, force.unwrap_or(false)).await
}

#[tauri::command]
async fn refresh_all_data(app: AppHandle) -> Result<RefreshSummary, String> {
    refresh_everything(&app).await
}

#[tauri::command]
async fn open_versus_window(app: AppHandle, username: String) -> Result<(), String> {
    let username = validate_username(&username)?;
    create_versus_window(&app, &username)?;
    mutate_config(&app, |c| {
        c.versus_history.retain(|u| !u.eq_ignore_ascii_case(&username));
        c.versus_history.insert(0, username.clone());
        if !c.open_versus.iter().any(|u| u.eq_ignore_ascii_case(&username)) {
            c.open_versus.push(username.clone());
        }
    })?;
    Ok(())
}

#[tauri::command]
fn remove_from_versus_history(app: AppHandle, username: String) -> Result<AppConfig, String> {
    mutate_config(&app, |c| c.versus_history.retain(|u| !u.eq_ignore_ascii_case(&username)))
}

#[tauri::command]
fn close_all_versus(app: AppHandle) -> Result<(), String> {
    for win in versus_windows(&app) {
        let _ = win.close();
    }
    mutate_config(&app, |c| c.open_versus.clear()).map(|_| ())
}

#[tauri::command]
fn minimize_to_tray(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    if window.label() == MAIN_LABEL {
        return window.hide().map_err(|e| e.to_string());
    }
    let user = versus_user(&window).unwrap_or_default();
    let _ = window.close();
    mutate_config(&app, |c| c.open_versus.retain(|u| !u.eq_ignore_ascii_case(&user))).map(|_| ())
}

#[tauri::command]
fn close_app(app: AppHandle) {
    quit(&app);
}

/// Resizes the calling window to fit its rendered content (logical pixels).
#[tauri::command]
fn fit_window(window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    if !width.is_finite() || !height.is_finite() {
        return Err("invalid size".into());
    }
    let (w, h) = (width.clamp(240.0, 2400.0).ceil(), height.clamp(80.0, 1600.0).ceil());
    let scale = window.scale_factor().unwrap_or(1.0);
    if let Ok(current) = window.inner_size() {
        let current = current.to_logical::<f64>(scale);
        if (current.width - w).abs() < 1.0 && (current.height - h).abs() < 1.0 {
            return Ok(());
        }
    }
    window.set_size(LogicalSize::new(w, h)).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/") {
        return Err("Only github.com links can be opened".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Saves a PNG snapshot (base64) into Pictures/GitHub Contribution Widget and
/// reveals it in the file manager. Returns the saved path.
#[tauri::command]
fn save_png(app: AppHandle, file_name: String, data_base64: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim_start_matches("data:image/png;base64,"))
        .map_err(|e| format!("invalid image data: {}", e))?;
    if !bytes.starts_with(b"\x89PNG") {
        return Err("not a PNG image".into());
    }
    let safe: String = file_name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .take(80)
        .collect();
    let safe = safe.trim_matches('.');
    let name = if safe.is_empty() { "contributions.png".to_string() } else if safe.ends_with(".png") { safe.to_string() } else { format!("{}.png", safe) };

    let base = app
        .path()
        .picture_dir()
        .or_else(|_| app.path().download_dir())
        .unwrap_or_else(|_| storage::data_dir(&app));
    let dir = base.join("GitHub Contribution Widget");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(name);
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    let _ = app.opener().reveal_item_in_dir(&path);
    Ok(path.to_string_lossy().into_owned())
}

// ── Main Entry Point ────────────────────────────────────────────────────────

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Launching the app again brings the widget back.
            show_main(app);
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_main(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let cfg = storage::read_config(&handle);
            let positions = storage::read_positions(&handle);

            app.manage(AppState {
                config: Mutex::new(cfg.clone()),
                http: github::build_client(),
                http_permits: Semaphore::new(4),
                user_locks: Mutex::new(HashMap::new()),
                failed_at: Mutex::new(HashMap::new()),
                positions: Mutex::new(positions),
                positions_gen: AtomicU64::new(0),
                click_through: AtomicBool::new(false),
                refreshing: AtomicBool::new(false),
                last_reminder: Mutex::new(None),
                last_goal: Mutex::new(None),
                shortcut: Mutex::new(None),
                tray_items: Mutex::new(None),
            });

            // Registry access is quick, but keep it off the startup path anyway.
            let launch = cfg.launch_at_startup;
            std::thread::spawn(move || {
                if let Err(e) = autostart::set_enabled(launch) {
                    eprintln!("autostart sync failed: {}", e);
                }
            });

            if let Err(e) = apply_shortcut(&handle, &cfg.shortcut) {
                eprintln!("{}", e);
            }

            let main_window = app.get_webview_window(MAIN_LABEL).expect("main window missing");
            place_window(&handle, &main_window, 0);
            apply_window_layer(&main_window, &cfg.window_layer);
            attach_window_events(&handle, &main_window);
            let _ = main_window.show();

            build_tray(&handle)?;
            if let Some(data) = storage::read_cache(&handle, &cfg, &cfg.username) {
                let summary = github::summarize(&data.weeks, Local::now().date_naive());
                update_tray_tooltip(&handle, Some((&cfg.username, &summary)));
            }

            for user in &cfg.open_versus {
                if let Err(e) = create_versus_window(&handle, user) {
                    eprintln!("failed to restore versus window for {}: {}", user, e);
                }
            }

            spawn_background_loop(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            update_config,
            get_data,
            fetch_contributions,
            fetch_user_contributions,
            refresh_all_data,
            open_versus_window,
            remove_from_versus_history,
            close_all_versus,
            minimize_to_tray,
            close_app,
            fit_window,
            open_external,
            save_png
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, event| {
        // Keep running in the tray when the last widget window closes;
        // only an explicit Quit (exit code set) ends the process.
        if let RunEvent::ExitRequested { api, code, .. } = event {
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}
