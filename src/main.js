const { app, BrowserWindow, ipcMain, Tray, Menu, screen, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { fetchContributions } = require('./githubService');

// Paths — handle both dev and packaged
const isPackaged = app.isPackaged;
const resourcesPath = isPackaged ? process.resourcesPath : path.join(__dirname, '..');
const configPath = path.join(resourcesPath, 'config.json');
const dataPath = path.join(resourcesPath, 'data.json');
const positionPath = path.join(app.getPath('userData'), 'position.json');

let mainWindow = null;
let tray = null;
let clickThrough = false;

// ── Config helpers ──────────────────────────────────────────────

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return { username: '', token: '' };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');
}

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  } catch {
    return { weeks: [], lastFetched: null, username: null };
  }
}

function saveData(data) {
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf-8');
}

function loadPosition() {
  try {
    return JSON.parse(fs.readFileSync(positionPath, 'utf-8'));
  } catch {
    return null;
  }
}

function savePosition(pos) {
  fs.writeFileSync(positionPath, JSON.stringify(pos, null, 2), 'utf-8');
}

// ── Window creation ─────────────────────────────────────────────

function createWindow() {
  const pos = loadPosition();
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;

  const winWidth = 880;
  const winHeight = 240;

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: pos ? pos.x : screenW - winWidth - 30,
    y: pos ? pos.y : screenH - winHeight - 30,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    hasShadow: false,
    type: 'desktop',          // sticks to the desktop background
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Save position on move
  mainWindow.on('moved', () => {
    const [x, y] = mainWindow.getPosition();
    savePosition({ x, y });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Prevent showing in Alt+Tab on some systems
  mainWindow.setSkipTaskbar(true);

  // Prevent getting lost when minimizing all windows (Win+D or Tab switching)
  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    if (mainWindow) {
      mainWindow.restore();
    }
  });
}

// ── Tray ────────────────────────────────────────────────────────

function createTray() {
  // Build a simple 16×16 green square icon
  const iconSize = 16;
  const icon = nativeImage.createEmpty();
  
  // Use a simple default icon approach
  const trayIconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
  let trayIcon;
  
  try {
    trayIcon = nativeImage.createFromPath(trayIconPath);
  } catch {
    // Create a small green square as fallback
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon.isEmpty() ? createFallbackIcon() : trayIcon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show/Hide Widget',
      click: () => {
        if (mainWindow) {
          mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
        }
      }
    },
    {
      label: 'Toggle Click-Through',
      type: 'checkbox',
      checked: clickThrough,
      click: (menuItem) => {
        clickThrough = menuItem.checked;
        if (mainWindow) {
          mainWindow.setIgnoreMouseEvents(clickThrough, { forward: true });
          mainWindow.webContents.send('click-through-changed', clickThrough);
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Refresh Data',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.send('trigger-refresh');
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('GitHub Contribution Widget');
  tray.setContextMenu(contextMenu);
}

function createFallbackIcon() {
  // Create a tiny 16x16 PNG with a green square
  // This is a minimal valid 16x16 RGBA buffer
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buffer[i * 4] = 57;      // R
    buffer[i * 4 + 1] = 211; // G
    buffer[i * 4 + 2] = 83;  // B
    buffer[i * 4 + 3] = 255; // A
  }
  return nativeImage.createFromBuffer(buffer, { width: size, height: size });
}

// ── IPC Handlers ────────────────────────────────────────────────

function setupIPC() {
  // Get cached data
  ipcMain.handle('get-data', () => {
    return loadData();
  });

  // Get config
  ipcMain.handle('get-config', () => {
    return loadConfig();
  });

  // Save config
  ipcMain.handle('save-config', (_, cfg) => {
    saveConfig(cfg);
    return { success: true };
  });

  // Fetch fresh data from GitHub
  ipcMain.handle('fetch-contributions', async () => {
    const config = loadConfig();
    if (!config.username) {
      return { error: 'No username configured' };
    }
    try {
      const weeks = await fetchContributions(config.username, config.token);
      const data = {
        weeks,
        lastFetched: new Date().toISOString(),
        username: config.username
      };
      saveData(data);
      return data;
    } catch (err) {
      return { error: err.message };
    }
  });

  // Fetch secondary user data
  ipcMain.handle('fetch-user-contributions', async (_, username) => {
    const config = loadConfig();
    try {
      const weeks = await fetchContributions(username, config.token);
      return { weeks, username };
    } catch (err) {
      return { error: err.message };
    }
  });

  let versusWindows = [];

  ipcMain.on('open-versus-window', (_, targetUser) => {
    const pos = loadPosition();
    const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
    const winWidth = 880;
    const winHeight = 240;

    const vsWin = new BrowserWindow({
      width: winWidth,
      height: winHeight,
      x: pos ? pos.x : screenW - winWidth - 30,
      y: pos ? pos.y - winHeight - 10 : screenH - (winHeight * 2) - 40,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      type: 'desktop',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js')
      }
    });

    // Pass the targetUser in the URL query string
    vsWin.loadFile(path.join(__dirname, 'index.html'), { query: { versus: targetUser } });

    vsWin.on('minimize', (event) => {
      event.preventDefault();
      vsWin.restore();
    });

    versusWindows.push(vsWin);
    vsWin.on('closed', () => {
      versusWindows = versusWindows.filter(w => w !== vsWin);
    });
  });

  // Close app
  ipcMain.on('close-app', () => {
    app.isQuitting = true;
    app.quit();
  });

  // Minimize to tray or close vs windows
  ipcMain.on('minimize-to-tray', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      if (win === mainWindow) {
        win.hide();
      } else {
        win.close();
      }
    }
  });
}

// ── App lifecycle ───────────────────────────────────────────────

// Suppress harmless cache errors on Windows
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

app.whenReady().then(() => {
  setupIPC();
  createWindow();
  createTray();

  // Auto-launch setup (Windows registry)
  app.setLoginItemSettings({
    openAtLogin: true,
    path: app.getPath('exe')
  });

  // Global shortcut to toggle visibility
  globalShortcut.register('CommandOrControl+Alt+G', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
      }
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
