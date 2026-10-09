# GitHub Contribution Widget

A lightweight, standalone Windows 11 desktop widget that displays your GitHub contribution graph. Built with Tauri v2 (Rust + WebView2), so it idles at a few MB of RAM instead of a full Electron runtime.

## Features

### Graph
- **Frameless & transparent** — sits on your desktop like a native widget and sizes itself to its content
- **13 color themes** — GitHub green, blue, purple, pink, orange, yellow, coral, cyan, teal, magenta, indigo, Halloween and monochrome
- **Hover tooltips** — exact contributions per day; **click a day** to open that day's activity on GitHub
- **Today highlight** and a live **stats row**: current streak, longest streak, best day and today's count
- **Daily goal** — progress bar toward a daily contribution target

### Stats & competition
- **Versus mode** — open up to 10 competitors as their own color-coded widgets, each with a head-to-head ("+276 ahead of you" / "You lead by 120"). Open versus windows are **restored on launch**, positions included
- **Leaderboard** — 30-day line chart with a crosshair tooltip, ranked list with totals, streaks and 7-day momentum, plus the scrolling stock ticker
- **Insights** — total, daily average, active days, current/longest streak, best day, best weekday, last-7-days momentum and a weekday chart
- **Export as PNG** — a shareable image of your graph, saved to `Pictures\GitHub Contribution Widget` and copied to the clipboard

### Always up to date
- **Auto-refresh** every 15 min – 12 h (or manual only); cached data shows instantly on launch
- **Streak reminder** — a desktop notification if you haven't contributed by your chosen time, and a celebration when you hit your daily goal
- **Tray tooltip** with your streak and today's count

### Desktop integration
- **Window layer** — normal, always on top, or pinned to the desktop
- **Lock position** to prevent accidental drags; drag from the title bar or footer otherwise
- **Configurable global shortcut** to show/hide the widget (default `Ctrl + Alt + F`)
- **Launch at startup** toggle
- **Click-through mode** from the tray
- **Multi-monitor safe** — if a saved position is off-screen (e.g. a monitor was unplugged), the widget moves back into view

## Quick Start

### 1. Install dependencies

Requires [Node.js](https://nodejs.org/) and the [Rust toolchain](https://rustup.rs/) with the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
npm install
```

### 2. Run in development

```bash
npm start
```

### 3. Configure

Click the **⚙ Settings** icon and enter your GitHub username. A personal access token is optional but recommended:

- Use **Create one ↗** in Settings (or go to https://github.com/settings/tokens) and generate a token with the `read:user` scope
- With a token, data comes from the GraphQL API: exact counts, and GitHub's own color levels

Settings are stored in `%APPDATA%\com.jaiman.githubwidget\config.json`.

### 4. Build

```bash
npm run build
```

Installers and the standalone `.exe` are written to `src-tauri/target/release/`.

Optionally, `scripts/create-shortcut.ps1` adds a Start Menu shortcut whose `Ctrl + Alt + F` hotkey launches the widget when it isn't running.

### Tests

```bash
npm test          # JS stats helpers + Rust parser/config tests
```

## Usage

| Action | How |
| --- | --- |
| Move the widget | Drag the title bar or footer (unless position is locked) |
| Refresh | ↻ button or `R` |
| Settings | ⚙ button or `S` |
| Versus mode | 👥 button or `V` |
| Leaderboard & insights | 📊 button or `L` |
| Export PNG | ⬇ button or `E` |
| Close a panel | `Esc` |
| Open your profile | Click the GitHub logo |
| Show / hide | Global shortcut (default `Ctrl + Alt + F`) or left-click the tray icon |

**Right-click the tray icon** for: Show/Hide, Refresh Now, Open GitHub Profile, Settings, Always on Top, Pin to Desktop, Lock Position, Click-Through and Quit.

## File Structure

```
/src
  index.html       — widget markup
  styles.css       — styling (themes are CSS variables set from renderer.js)
  renderer.js      — UI logic
  stats.js         — pure statistics/formatting helpers (shared with tests)
/src-tauri/src
  main.rs          — app setup, windows, tray, commands, background refresh
  github.rs        — GitHub GraphQL + HTML fetching and parsing
  storage.rs       — config, caches and window positions (atomic JSON writes)
  autostart.rs     — launch-at-startup via the Windows Run registry key
/tests             — Node unit tests
```

## Connect with Me

Developed by **Arindam Jaiman**. Feel free to connect:
- **GitHub:** [https://github.com/ArindamJaiman](https://github.com/ArindamJaiman)
- **LinkedIn:** [https://www.linkedin.com/in/arindam-jaiman-6149a82ab/](https://www.linkedin.com/in/arindam-jaiman-6149a82ab/)
- **Instagram:** [https://www.instagram.com/thearindamjaiman](https://www.instagram.com/thearindamjaiman)
