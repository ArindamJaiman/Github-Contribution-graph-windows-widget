//! Makes "Pin to desktop" behave like a phone home-screen widget on Windows:
//! the widget sits under your apps, stays out of Alt+Tab, and stays visible
//! when you show the desktop (Win+D).
//!
//! - A pinned widget is owned by the desktop window (Progman). Win+D hides
//!   every window except the desktop and the windows it owns, so the widget
//!   stays. (Lifting it ourselves doesn't work: Windows won't let a
//!   background app raise its windows above others.)
//! - Whenever an app comes to the front (including when Win+D is undone) the
//!   widget is pushed back under the apps; lowering is always allowed.
//!   Clicking the widget brings it forward until you switch to an app.
//!
//! This replaces tao's always-on-bottom, which keeps the widget hidden behind
//! the desktop during Win+D.

/// What kind of window just came to the front.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Foreground {
    /// The desktop (wallpaper and icons).
    Desktop,
    /// An ordinary application window.
    App,
    /// Taskbar, Start, task switcher and similar shell UI.
    Shell,
}

/// Classifies a foreground window by its class name.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn kind(class: &str, hosts_desktop_icons: bool) -> Foreground {
    match class {
        "Progman" => Foreground::Desktop,
        "WorkerW" if hosts_desktop_icons => Foreground::Desktop,
        "" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "NotifyIconOverflowWindow"
        | "TopLevelWindowForOverflowXamlIsland" | "Windows.UI.Core.CoreWindow" | "XamlExplorerHostIslandWindow"
        | "MultitaskingViewFrame" | "ForegroundStaging" => Foreground::Shell,
        _ => Foreground::App,
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use std::sync::{Mutex, Once};

    use tauri::WebviewWindow;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowExW, FindWindowW, GetClassNameW, GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos,
        EVENT_SYSTEM_FOREGROUND, GWLP_HWNDPARENT, GWL_EXSTYLE, HWND_BOTTOM, HWND_NOTOPMOST, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };

    use super::{kind, Foreground};

    /// Pinned windows (as raw handles), pushed back down when an app comes
    /// to the front.
    static PINNED: Mutex<Vec<isize>> = Mutex::new(Vec::new());
    static HOOK: Once = Once::new();

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn hwnd_of(win: &WebviewWindow) -> Option<HWND> {
        win.hwnd().ok().map(|h| h.0 as HWND)
    }

    /// The desktop window that hosts the wallpaper and icons.
    fn desktop_window() -> HWND {
        let class = wide("Progman");
        unsafe { FindWindowW(class.as_ptr(), std::ptr::null()) }
    }

    fn class_name(hwnd: HWND) -> String {
        let mut buf = [0u16; 128];
        let len = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        String::from_utf16_lossy(&buf[..len.max(0) as usize])
    }

    fn hosts_desktop_icons(hwnd: HWND) -> bool {
        let class = wide("SHELLDLL_DefView");
        !unsafe { FindWindowExW(hwnd, std::ptr::null_mut(), class.as_ptr(), std::ptr::null()) }.is_null()
    }

    fn owner(hwnd: HWND) -> HWND {
        unsafe { GetWindowLongPtrW(hwnd, GWLP_HWNDPARENT) as HWND }
    }

    fn set_owner(hwnd: HWND, owner: HWND) {
        unsafe { SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, owner as isize) };
    }

    fn set_z(hwnd: HWND, after: HWND) {
        unsafe {
            SetWindowPos(hwnd, after, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }

    unsafe extern "system" fn on_foreground(
        _hook: HWINEVENTHOOK,
        _event: u32,
        hwnd: HWND,
        _id_object: i32,
        _id_child: i32,
        _thread: u32,
        _time: u32,
    ) {
        if hwnd.is_null() {
            return;
        }
        let class = class_name(hwnd);
        if kind(&class, class == "WorkerW" && hosts_desktop_icons(hwnd)) == Foreground::App {
            for &raw in PINNED.lock().unwrap().iter() {
                set_z(raw as HWND, HWND_BOTTOM);
            }
        }
    }

    /// Pins a window to the desktop. Must run on the window's own (main)
    /// thread, which then also receives the foreground events.
    pub fn pin(win: &WebviewWindow) {
        let Some(hwnd) = hwnd_of(win) else { return };
        HOOK.call_once(|| {
            let hook = unsafe {
                SetWinEventHook(
                    EVENT_SYSTEM_FOREGROUND,
                    EVENT_SYSTEM_FOREGROUND,
                    std::ptr::null_mut(),
                    Some(on_foreground),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
                )
            };
            if hook.is_null() {
                eprintln!("couldn't watch the foreground window; pinned widgets may stay above apps after Win+D");
            }
        });
        {
            let mut pinned = PINNED.lock().unwrap();
            if !pinned.contains(&(hwnd as isize)) {
                pinned.push(hwnd as isize);
            }
        }
        let desktop = desktop_window();
        if !desktop.is_null() && owner(hwnd) != desktop {
            set_owner(hwnd, desktop);
        }
        set_z(hwnd, HWND_BOTTOM);
    }

    /// Re-pins if the window lost its owner, e.g. after Explorer restarted
    /// (the widget survives that, but the new desktop window isn't its owner).
    pub fn repin_if_needed(win: &WebviewWindow) {
        let Some(hwnd) = hwnd_of(win) else { return };
        let desktop = desktop_window();
        if !desktop.is_null() && owner(hwnd) != desktop {
            pin(win);
        }
    }

    /// Releases a pinned window. `drop_topmost` clears any topmost state (skip
    /// it for the "always on top" layer, which tao manages).
    pub fn unpin(win: &WebviewWindow, drop_topmost: bool) {
        let Some(hwnd) = hwnd_of(win) else { return };
        PINNED.lock().unwrap().retain(|&raw| raw != hwnd as isize);
        if !owner(hwnd).is_null() {
            set_owner(hwnd, std::ptr::null_mut());
        }
        if drop_topmost {
            set_z(hwnd, HWND_NOTOPMOST);
        }
    }

    /// Hides a window from Alt+Tab (tool window) or restores it.
    pub fn set_tool_window(win: &WebviewWindow, tool: bool) {
        let Some(hwnd) = hwnd_of(win) else { return };
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            let next = if tool {
                (ex | WS_EX_TOOLWINDOW) & !WS_EX_APPWINDOW
            } else {
                (ex & !WS_EX_TOOLWINDOW) | WS_EX_APPWINDOW
            };
            if next != ex {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next as isize);
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub use imp::{pin, repin_if_needed, set_tool_window, unpin};

#[cfg(not(target_os = "windows"))]
mod imp_other {
    use tauri::WebviewWindow;

    pub fn pin(win: &WebviewWindow) {
        let _ = win.set_always_on_bottom(true);
    }
    pub fn repin_if_needed(_win: &WebviewWindow) {}
    pub fn unpin(win: &WebviewWindow, _drop_topmost: bool) {
        let _ = win.set_always_on_bottom(false);
    }
    pub fn set_tool_window(_win: &WebviewWindow, _tool: bool) {}
}

#[cfg(not(target_os = "windows"))]
pub use imp_other::{pin, repin_if_needed, set_tool_window, unpin};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_apps_and_shell_ui_are_told_apart() {
        assert_eq!(kind("Progman", true), Foreground::Desktop);
        assert_eq!(kind("WorkerW", true), Foreground::Desktop);
        assert_eq!(kind("WorkerW", false), Foreground::Shell);
        assert_eq!(kind("Shell_TrayWnd", false), Foreground::Shell);
        assert_eq!(kind("ForegroundStaging", false), Foreground::Shell);
        assert_eq!(kind("Chrome_WidgetWin_1", false), Foreground::App);
        assert_eq!(kind("CabinetWClass", false), Foreground::App); // File Explorer
    }
}
