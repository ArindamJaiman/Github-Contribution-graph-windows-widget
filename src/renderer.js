/**
 * renderer.js — UI logic for the GitHub Contribution Widget
 * Communicates with the backend using the window.api shim.
 */

// ── Tauri window.api Shim ───────────────────────────────────────
if (window.__TAURI__) {
  const { invoke } = window.__TAURI__.core;
  const { listen, emit } = window.__TAURI__.event;
  
  window.api = {
    getData: () => invoke('get_data'),
    getConfig: () => invoke('get_config'),
    saveConfig: (cfg) => invoke('save_config', { config: cfg }),
    fetchContributions: () => invoke('fetch_contributions'),
    fetchUserContributions: (user) => invoke('fetch_user_contributions', { username: user }),
    openVersusWindow: (user) => invoke('open_versus_window', { username: user }),
    closeApp: () => invoke('close_app'),
    minimizeToTray: () => invoke('minimize_to_tray'),
    closeAllVersus: () => invoke('close_all_versus'),
    addToVersusHistory: (user) => invoke('add_to_versus_history', { username: user }),
    refreshAllData: () => invoke('refresh_all_data'),
    emitOpacityChanged: (val) => emit('opacity-changed', val),
    onOpacityChanged: (callback) => listen('opacity-changed', (event) => callback(event.payload)),
    onTriggerRefresh: (callback) => listen('trigger-refresh', callback),
    onClickThroughChanged: (callback) => listen('click-through-changed', (event) => callback(event.payload))
  };
}

// ── DOM References ──────────────────────────────────────────────
const graphGrid     = document.getElementById('graphGrid');
const monthsRow     = document.getElementById('monthsRow');
const tooltip       = document.getElementById('tooltip');
const statusText    = document.getElementById('statusText');
const titleText     = document.getElementById('titleText');
const loadingOverlay = document.getElementById('loadingOverlay');
const settingsPanel = document.getElementById('settingsPanel');
const inputUsername  = document.getElementById('inputUsername');
const inputToken    = document.getElementById('inputToken');
const widget        = document.getElementById('widget');

const btnRefresh       = document.getElementById('btnRefresh');
const btnSettings      = document.getElementById('btnSettings');
const btnClose         = document.getElementById('btnClose');
const btnSaveSettings  = document.getElementById('btnSaveSettings');
const btnCancelSettings = document.getElementById('btnCancelSettings');
const btnRefreshAll    = document.getElementById('btnRefreshAll');

const btnVs            = document.getElementById('btnVs');
const vsPanel          = document.getElementById('vsPanel');
const inputVsUser      = document.getElementById('inputVsUser');
const btnCancelVs      = document.getElementById('btnCancelVs');
const btnStartVs       = document.getElementById('btnStartVs');
const btnCloseAllVs    = document.getElementById('btnCloseAllVs');
const inputOpacity     = document.getElementById('inputOpacity');
const opacityValue     = document.getElementById('opacityValue');
const vsHistoryList    = document.getElementById('vsHistoryList');

// ── State ───────────────────────────────────────────────────────
let currentData = null;

// ── Opacity Helper ──────────────────────────────────────────────
function applyOpacity(percent) {
  const alpha = Math.max(0, Math.min(100, percent)) / 100;
  widget.style.background = `rgba(13, 17, 23, ${alpha})`;
}

// ── Formatters ──────────────────────────────────────────────────
const dateFormatter = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const statusTimeFormatter = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit' });
const statusDateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

// ── Month names ─────────────────────────────────────────────────
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── Initialization ──────────────────────────────────────────────
async function init() {
  let vsUser = null;
  
  if (window.__TAURI__) {
    try {
      let currentWin = null;
      if (window.__TAURI__.webviewWindow && typeof window.__TAURI__.webviewWindow.getCurrentWebviewWindow === 'function') {
        currentWin = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
      } else if (window.__TAURI__.window && typeof window.__TAURI__.window.getCurrentWindow === 'function') {
        currentWin = window.__TAURI__.window.getCurrentWindow();
      }
      
      if (currentWin && currentWin.label) {
        const label = currentWin.label;
        if (label.startsWith('versus_')) {
          vsUser = label.replace('versus_', '');
        }
      }
    } catch (e) {
      console.error("Failed to retrieve window label in Tauri:", e);
    }
  } else {
    const urlParams = new URLSearchParams(window.location.search);
    vsUser = urlParams.get('versus');
  }

  // Load config for all modes to apply shared settings like opacity
  const config = await window.api.getConfig();
  const opacity = config.opacity != null ? config.opacity : 92;
  applyOpacity(opacity);

  if (vsUser) {
    const vibrantThemes = ['theme-orange', 'theme-purple', 'theme-blue', 'theme-pink', 'theme-cyan', 'theme-teal', 'theme-magenta', 'theme-indigo', 'theme-yellow', 'theme-coral'];
    const hash = vsUser.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const selectedTheme = vibrantThemes[hash % vibrantThemes.length];
    
    document.body.classList.add(selectedTheme);
    if (btnVs) btnVs.style.display = 'none';
    if (btnSettings) btnSettings.style.display = 'none';
    if (btnRefresh) btnRefresh.style.display = 'none';
    titleText.textContent = `${vsUser}'s contributions`;
    await loadVsData(vsUser);
    return;
  }

  // Load cached data first for instant display
  const cached = await window.api.getData();
  if (cached && cached.weeks && cached.weeks.length > 0) {
    currentData = cached;
    renderGraph(cached.weeks);
    updateStatus(cached);
  } else {
    showNoData();
  }

  // Populate settings panel
  inputUsername.value = config.username || '';
  inputToken.value = config.token || '';

  if (inputOpacity) {
    inputOpacity.value = opacity;
    opacityValue.textContent = `${opacity}%`;
  }

  // Populate versus history datalist
  if (vsHistoryList && config.versus_history && config.versus_history.length > 0) {
    vsHistoryList.innerHTML = '';
    config.versus_history.forEach(u => {
      const opt = document.createElement('option');
      opt.value = u;
      vsHistoryList.appendChild(opt);
    });
  }

  if (config.username) {
    titleText.textContent = `${config.username}'s contributions`;
  }

  // If we have a username but no cached data, fetch fresh data once
  if (config.username && (!currentData || currentData.weeks.length === 0)) {
    await refreshData();
  }
}

// ── Data Fetching ───────────────────────────────────────────────
async function loadVsData(username) {
  showLoading(true);
  try {
    const result = await window.api.fetchUserContributions(username);
    if (result.error) {
      setStatus(`Error: ${result.error}`, true);
      showNoData();
    } else {
      currentData = result;
      renderGraph(result.weeks);
      updateStatus(result);
    }
  } catch (err) {
    const errorMsg = typeof err === 'string' ? err : (err.message || 'Unknown error');
    setStatus(`Fetch failed: ${errorMsg}`, true);
  } finally {
    showLoading(false);
  }
}

async function refreshData() {
  showLoading(true);
  btnRefresh.classList.add('spinning');

  try {
    const result = await window.api.fetchContributions();

    if (result.error) {
      setStatus(`Error: ${result.error}`, true);
      // Keep showing cached data if available
      if (!currentData || !currentData.weeks || currentData.weeks.length === 0) {
        showNoData();
      }
    } else {
      currentData = result;
      renderGraph(result.weeks);
      updateStatus(result);
    }
  } catch (err) {
    const errorMsg = typeof err === 'string' ? err : (err.message || 'Unknown error');
    setStatus(`Fetch failed: ${errorMsg}`, true);
  } finally {
    showLoading(false);
    btnRefresh.classList.remove('spinning');
  }
}

// ── Render Contribution Graph ───────────────────────────────────
function renderGraph(weeks) {
  graphGrid.innerHTML = '';
  monthsRow.innerHTML = '';

  if (!weeks || weeks.length === 0) {
    showNoData();
    return;
  }

  // Remove any no-data message
  const existing = graphGrid.querySelector('.no-data');
  if (existing) existing.remove();

  // Determine how many weeks to show (last ~52 weeks for a year)
  const displayWeeks = weeks.slice(-53);

  // Build month labels
  buildMonthLabels(displayWeeks);

  const fragment = document.createDocumentFragment();

  // Build grid columns
  displayWeeks.forEach((week) => {
    const col = document.createElement('div');
    col.className = 'week-column';

    // Pad the first week if it doesn't start on Sunday (index 0)
    if (displayWeeks.indexOf(week) === 0 && week.length < 7) {
      const pad = 7 - week.length;
      for (let i = 0; i < pad; i++) {
        const empty = document.createElement('div');
        empty.className = 'day-cell empty';
        col.appendChild(empty);
      }
    }

    week.forEach((day) => {
      const cell = document.createElement('div');
      cell.className = 'day-cell';
      cell.setAttribute('data-level', day.level);
      cell.setAttribute('data-date', day.date);
      cell.setAttribute('data-count', day.count);

      col.appendChild(cell);
    });

    fragment.appendChild(col);
  });
  
  graphGrid.appendChild(fragment);
}

// ── Month Labels ────────────────────────────────────────────────
function buildMonthLabels(weeks) {
  monthsRow.innerHTML = '';

  // Calculate cell width + gap
  const cellSize = 11 + 3; // 11px cell + 3px gap

  let lastMonth = -1;
  let monthPositions = [];

  weeks.forEach((week, i) => {
    if (week.length > 0) {
      const date = new Date(week[0].date);
      const month = date.getMonth();
      if (month !== lastMonth) {
        monthPositions.push({ month, index: i });
        lastMonth = month;
      }
    }
  });

  const fragment = document.createDocumentFragment();

  monthPositions.forEach((mp, i) => {
    const label = document.createElement('span');
    label.className = 'month-label';
    label.textContent = MONTH_NAMES[mp.month];

    // Calculate width until next month
    const nextIndex = i + 1 < monthPositions.length ? monthPositions[i + 1].index : weeks.length;
    const span = nextIndex - mp.index;
    label.style.width = `${span * cellSize}px`;
    label.style.minWidth = `${span * cellSize}px`;

    fragment.appendChild(label);
  });
  
  monthsRow.appendChild(fragment);
}

// ── Tooltip ─────────────────────────────────────────────────────
function showTooltip(targetElement, day) {
  const count = day.count;
  const dateStr = formatDate(day.date);
  const plural = count === 1 ? 'contribution' : 'contributions';

  tooltip.innerHTML = `<span class="tip-count">${count} ${plural}</span><span class="tip-date">on ${dateStr}</span>`;

  // Position tooltip above the cell
  const cellRect = targetElement.getBoundingClientRect();
  const widgetRect = widget.getBoundingClientRect();
  const tooltipX = cellRect.left - widgetRect.left + cellRect.width / 2;
  const tooltipY = cellRect.top - widgetRect.top - 8;

  tooltip.style.left = `${tooltipX}px`;
  tooltip.style.top = `${tooltipY}px`;
  tooltip.style.transform = 'translate(-50%, -100%)';
  tooltip.classList.add('visible');
}

function hideTooltip() {
  tooltip.classList.remove('visible');
}

function formatDate(dateStr) {
  const date = new Date(dateStr + 'T00:00:00');
  return dateFormatter.format(date);
}

// ── Status ──────────────────────────────────────────────────────
function updateStatus(data) {
  if (data.lastFetched) {
    const date = new Date(data.lastFetched);
    const timeStr = statusTimeFormatter.format(date);
    const dateStr = statusDateFormatter.format(date);
    statusText.textContent = `Updated ${dateStr} at ${timeStr}`;
    statusText.style.color = '#484f58';
  }

  if (data.username) {
    titleText.textContent = `${data.username}'s contributions`;
  }

  // Calculate total contributions
  if (data.weeks) {
    let total = 0;
    data.weeks.forEach(week => {
      week.forEach(day => { total += day.count; });
    });
    // Show total in title on hover
    widget.title = `${total} contributions in the last year`;
  }
}

function setStatus(msg, isError = false) {
  statusText.textContent = msg;
  statusText.style.color = isError ? '#f85149' : '#484f58';
}

// ── No Data State ───────────────────────────────────────────────
function showNoData() {
  graphGrid.innerHTML = '';
  monthsRow.innerHTML = '';

  const noData = document.createElement('div');
  noData.className = 'no-data';
  noData.innerHTML = 'No data yet. <a id="openSettingsLink">Configure username</a> to get started.';
  graphGrid.appendChild(noData);

  // Wire up the link
  setTimeout(() => {
    const link = document.getElementById('openSettingsLink');
    if (link) {
      link.addEventListener('click', () => openSettings());
    }
  }, 0);
}

// ── Loading ─────────────────────────────────────────────────────
function showLoading(show) {
  if (show) {
    loadingOverlay.classList.add('visible');
  } else {
    loadingOverlay.classList.remove('visible');
  }
}

// ── Settings ────────────────────────────────────────────────────
function openSettings() {
  settingsPanel.classList.add('visible');
  inputUsername.focus();
}

function closeSettings() {
  settingsPanel.classList.remove('visible');
}

// Live opacity slider preview
if (inputOpacity) {
  inputOpacity.addEventListener('input', () => {
    const val = inputOpacity.value;
    opacityValue.textContent = `${val}%`;
    const parsedVal = parseInt(val, 10);
    applyOpacity(parsedVal);
    if (window.api.emitOpacityChanged) {
      window.api.emitOpacityChanged(parsedVal);
    }
  });
}

// ── Event Listeners ─────────────────────────────────────────────

// Graph Grid Event Delegation for Tooltips
graphGrid.addEventListener('mouseover', (e) => {
  if (e.target.classList.contains('day-cell') && !e.target.classList.contains('empty')) {
    const date = e.target.getAttribute('data-date');
    const count = parseInt(e.target.getAttribute('data-count'), 10);
    showTooltip(e.target, { date, count });
  }
});

graphGrid.addEventListener('mouseout', (e) => {
  if (e.target.classList.contains('day-cell') && !e.target.classList.contains('empty')) {
    hideTooltip();
  }
});

// Refresh button
btnRefresh.addEventListener('click', () => {
  refreshData();
});

// Settings button
btnSettings.addEventListener('click', () => {
  openSettings();
});

// Close button — minimize to tray
btnClose.addEventListener('click', () => {
  window.api.minimizeToTray();
});

// Cancel settings
btnCancelSettings.addEventListener('click', () => {
  closeSettings();
});

// Save settings & refresh
btnSaveSettings.addEventListener('click', async () => {
  const username = inputUsername.value.trim();
  const token = inputToken.value.trim();
  const opacity = inputOpacity ? parseInt(inputOpacity.value, 10) : 92;

  if (!username) {
    inputUsername.style.borderColor = '#f85149';
    inputUsername.focus();
    return;
  }

  inputUsername.style.borderColor = '';

  // Preserve existing versus_history from config
  const currentConfig = await window.api.getConfig();
  await window.api.saveConfig({
    username,
    token,
    opacity,
    versus_history: currentConfig.versus_history || []
  });
  applyOpacity(opacity);
  closeSettings();
  titleText.textContent = `${username}'s contributions`;
  await refreshData();
});

// Enter key in settings inputs
inputUsername.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnSaveSettings.click();
});
inputToken.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnSaveSettings.click();
});

// VS mode UI bindings
if (btnVs) {
  btnVs.addEventListener('click', () => {
    vsPanel.classList.add('visible');
    inputVsUser.focus();
  });
}
if (btnCancelVs) {
  btnCancelVs.addEventListener('click', () => {
    vsPanel.classList.remove('visible');
  });
}
if (btnStartVs) {
  btnStartVs.addEventListener('click', async () => {
    const raw = inputVsUser.value.trim();
    if (!raw) {
      inputVsUser.style.borderColor = '#f85149';
      inputVsUser.focus();
      return;
    }
    inputVsUser.style.borderColor = '';

    // Parse comma-separated usernames, limit to 10
    const usernames = raw.split(/[,]+/)
      .map(u => u.trim())
      .filter(u => u.length > 0)
      .slice(0, 10);

    let errors = [];
    for (const username of usernames) {
      try {
        await window.api.openVersusWindow(username);
        // Save to versus history
        await window.api.addToVersusHistory(username);
      } catch (e) {
        console.error(`Failed to open versus window for ${username}:`, e);
        errors.push(username);
      }
    }

    // Refresh the datalist with updated history
    try {
      const cfg = await window.api.getConfig();
      if (vsHistoryList && cfg.versus_history) {
        vsHistoryList.innerHTML = '';
        cfg.versus_history.forEach(u => {
          const opt = document.createElement('option');
          opt.value = u;
          vsHistoryList.appendChild(opt);
        });
      }
    } catch (_) {}

    if (errors.length > 0) {
      alert(`Could not open versus for: ${errors.join(', ')}`);
    }

    vsPanel.classList.remove('visible');
    inputVsUser.value = '';
  });
}
if (btnCloseAllVs) {
  btnCloseAllVs.addEventListener('click', async () => {
    try {
      await window.api.closeAllVersus();
    } catch (e) {
      console.error('Failed to close versus windows:', e);
    }
    vsPanel.classList.remove('visible');
  });
}
if (inputVsUser) {
  inputVsUser.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnStartVs.click();
  });
}

// Escape to close panels
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (settingsPanel && settingsPanel.classList.contains('visible')) {
      closeSettings();
    }
    if (vsPanel && vsPanel.classList.contains('visible')) {
      vsPanel.classList.remove('visible');
    }
  }
});

// Listen for tray-triggered refresh
window.api.onTriggerRefresh(() => {
  refreshData();
});

// Listen for global opacity changes (for live updates across windows)
if (window.api.onOpacityChanged) {
  window.api.onOpacityChanged((val) => {
    applyOpacity(val);
    if (inputOpacity && opacityValue) {
      inputOpacity.value = val;
      opacityValue.textContent = `${val}%`;
    }
  });
}

// Listen for click-through toggle
window.api.onClickThroughChanged((enabled) => {
  if (enabled) {
    widget.classList.add('click-through');
  } else {
    widget.classList.remove('click-through');
  }
});

// ── Start ───────────────────────────────────────────────────────
init();
