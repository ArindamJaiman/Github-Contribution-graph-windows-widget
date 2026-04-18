# GitHub Contribution Widget

A lightweight, standalone Windows 11 desktop widget that displays your GitHub contribution graph.

## Features

- **Frameless & transparent** — sits on your desktop like a native widget
- **GitHub dark theme** — authentic contribution graph colors
- **Hover tooltips** — see contribution counts per day  
- **Settings panel** — configure username & token in-app
- **Tray icon** — hide/show, toggle click-through, refresh
- **Auto-launch** — starts with Windows
- **Single fetch** — loads data once on startup, manual refresh only
- **Position memory** — remembers where you place it

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure

Edit `config.json`:
```json
{
  "username": "your-github-username",
  "token": ""
}
```

**Token is optional** but recommended for reliable data:
- Go to https://github.com/settings/tokens
- Generate a token with `read:user` scope
- Paste it in the token field

### 3. Run in Development

```bash
npm start
```

### 4. Build Portable .exe

```bash
npm run build
```

The portable `.exe` will be in `dist/` — no installation needed.

### 5. Build Installer .exe

```bash
npm run build:installer
```

## Usage

- **Drag** the widget by its top area to reposition
- **Click the ⚙ icon** to change username/token
- **Click the ↻ icon** to manually refresh data
- **Click the ✕ icon** to minimize to system tray
- **Right-click the tray icon** for more options:
  - Show/Hide Widget
  - Toggle Click-Through mode
  - Refresh Data
  - Quit

## File Structure

```
/project
  /src
    main.js          — Electron main process
    preload.js       — Context bridge (IPC)
    renderer.js      — UI logic
    index.html       — Widget markup
    styles.css       — Styling
    githubService.js — GitHub data fetching
  /assets
    icon.ico         — App icon (optional)
  config.json        — User configuration
  data.json          — Cached contribution data
  package.json       — Project config & build settings
```

## Connect with Me

Developed by **Arindam Jaiman**. Feel free to connect:
- **GitHub:** [https://github.com/ArindamJaiman](https://github.com/ArindamJaiman)
- **LinkedIn:** [https://www.linkedin.com/in/arindam-jaiman-6149a82ab/](https://www.linkedin.com/in/arindam-jaiman-6149a82ab/)
- **Instagram:** [https://www.instagram.com/thearindamjaiman](https://www.instagram.com/thearindamjaiman)
