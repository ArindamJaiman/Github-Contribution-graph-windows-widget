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

const btnStats         = document.getElementById('btnStats');
const statsPanel       = document.getElementById('statsPanel');
const statsGraphContainer = document.getElementById('statsGraphContainer');
const statsTicker      = document.getElementById('statsTicker');
const graphTooltip     = document.getElementById('graphTooltip');
const btnCancelStats   = document.getElementById('btnCancelStats');

const GRAPH_COLORS = ['#39d353', '#58a6ff', '#e3b341', '#a371f7', '#f06461', '#ff7b72', '#d2a8ff', '#79c0ff', '#ffa657', '#fa4549'];

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

// ── Statistics Leaderboard ──────────────────────────────────────
function calculateStats(username, weeks) {
  let total = 0;
  let longestStreak = 0;
  let currentStreak = 0;
  let maxDay = 0;
  let currentStreakActive = true;

  // weeks is an array of weeks, week is an array of days
  // To calculate streak properly, we should flatten and iterate backwards
  let flatDays = [];
  weeks.forEach(w => w.forEach(d => flatDays.push(d)));

  // Calculate Total & Max Day
  flatDays.forEach(d => {
    total += d.count;
    if (d.count > maxDay) maxDay = d.count;
  });

  // Calculate Streaks
  let tempStreak = 0;
  // Traverse forwards for longest streak
  for (let i = 0; i < flatDays.length; i++) {
    if (flatDays[i].count > 0) {
      tempStreak++;
      if (tempStreak > longestStreak) longestStreak = tempStreak;
    } else {
      tempStreak = 0;
    }
  }

  // Traverse backwards for current streak (ignoring today if it's 0, but if yesterday is 0, streak is 0)
  tempStreak = 0;
  let foundFirst = false;
  for (let i = flatDays.length - 1; i >= 0; i--) {
    if (flatDays[i].count > 0) {
      tempStreak++;
      foundFirst = true;
    } else if (flatDays[i].count === 0) {
      if (!foundFirst && i >= flatDays.length - 2) {
        // If today or yesterday is 0 and we haven't started counting, keep going
        continue;
      } else {
        break; // Streak broken
      }
    }
  }
  currentStreak = tempStreak;
  
  // Collect the last 30 days for the graph
  let last30 = flatDays.slice(-30);

  return { username, total, longestStreak, currentStreak, maxDay, last30 };
}

async function renderStats() {
  statsGraphContainer.innerHTML = '<div class="no-data" style="height: 100px;">Calculating statistics...</div>';
  statsTicker.innerHTML = '';
  
  try {
    const config = await window.api.getConfig();
    let usersToFetch = [];
    if (config.username) usersToFetch.push(config.username);
    
    if (config.versus_history && config.versus_history.length > 0) {
      config.versus_history.forEach(item => {
        const competitors = item.split(/[,]+/).map(u => u.trim()).filter(u => u.length > 0);
        usersToFetch.push(...competitors);
      });
    }
    
    // Deduplicate
    usersToFetch = [...new Set(usersToFetch)];

    if (usersToFetch.length === 0) {
      statsGraphContainer.innerHTML = '<div class="no-data">No developers configured.</div>';
      return;
    }

    // Fetch all sequentially to avoid overwhelming
    let stats = [];
    for (const user of usersToFetch) {
      try {
        const data = await window.api.fetchUserContributions(user);
        if (data && data.weeks) {
          stats.push(calculateStats(user, data.weeks));
        }
      } catch (e) {
        console.error(`Failed to fetch stats for ${user}:`, e);
      }
    }

    // Sort by Total Contributions descending
    stats.sort((a, b) => b.total - a.total);

    statsGraphContainer.innerHTML = '';
    
    // 1. Render Ticker Tape
    let tickerHtml = '';
    stats.forEach((stat, index) => {
      const color = GRAPH_COLORS[index % GRAPH_COLORS.length];
      tickerHtml += `
        <div class="ticker-item">
          <div class="color-dot" style="background-color: ${color};"></div>
          <strong>${stat.username}</strong>
          <span class="total">${stat.total} Total</span>
          <span class="streak">🔥 ${stat.currentStreak} Day Streak</span>
        </div>
      `;
    });
    
    // Duplicate the ticker items for seamless infinite scroll
    statsTicker.innerHTML = tickerHtml + tickerHtml;

    // 2. Render SVG Line Chart (Sparklines)
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    // Ensure the SVG fills its container
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    // Set up a viewBox for easy coordinate mapping (e.g. x: 0-30 days, y: 0-maxCount)
    
    // Find the maximum daily count across all users to scale the Y axis
    let globalMaxDay = 0;
    stats.forEach(stat => {
      if (stat.maxDay > globalMaxDay) globalMaxDay = stat.maxDay;
    });
    // Add a bit of padding to the top (10% extra)
    const yMax = globalMaxDay > 0 ? Math.ceil(globalMaxDay * 1.1) : 10;
    
    // Our logical coordinate system
    svg.setAttribute("viewBox", `0 0 30 ${yMax}`);
    svg.setAttribute("preserveAspectRatio", "none");

    // Create a group for the lines to flip the Y axis (SVG puts 0,0 at top-left)
    const g = document.createElementNS(svgNS, "g");
    g.setAttribute("transform", `translate(0, ${yMax}) scale(1, -1)`);
    svg.appendChild(g);

    // Find the main user's stats for comparison
    const mainUser = config.username ? config.username.toLowerCase() : "";
    const mainUserStat = stats.find(s => s.username.toLowerCase() === mainUser);

    // Render each user's line
    stats.forEach((stat, index) => {
      const color = GRAPH_COLORS[index % GRAPH_COLORS.length];
      
      const polyline = document.createElementNS(svgNS, "polyline");
      
      // Build the points string
      // Days are 0 to 29 on the X axis, Y is the count
      let points = "";
      stat.last30.forEach((day, i) => {
        // For smooth appearance, start from 0 if there's no data
        const count = day ? day.count : 0;
        points += `${i},${count} `;
      });
      
      polyline.setAttribute("points", points.trim());
      polyline.setAttribute("class", "sparkline-path");
      polyline.setAttribute("stroke", color);
      polyline.setAttribute("vector-effect", "non-scaling-stroke");
      
      // Calculate comparison for tooltip
      let comparisonHtml = '';
      if (mainUserStat && stat.username.toLowerCase() !== mainUser) {
        const diff = stat.total - mainUserStat.total;
        const pct = mainUserStat.total > 0 ? ((Math.abs(diff) / mainUserStat.total) * 100).toFixed(1) : 0;
        
        if (diff > 0) {
          comparisonHtml = `<div style="margin-top:4px; color: #f85149;">They are ahead by ${diff} (+${pct}%)</div>`;
        } else if (diff < 0) {
          comparisonHtml = `<div style="margin-top:4px; color: #39d353;">You are ahead by ${Math.abs(diff)} (+${pct}%)</div>`;
        } else {
          comparisonHtml = `<div style="margin-top:4px; color: #e3b341;">You are tied!</div>`;
        }
      } else if (stat.username.toLowerCase() === mainUser) {
        comparisonHtml = `<div style="margin-top:4px; color: #58a6ff;">This is you!</div>`;
      }
      
      const tooltipHtml = `
        <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px;">
          <div style="width:10px; height:10px; border-radius:50%; background-color:${color};"></div>
          <strong style="font-size:14px;">${stat.username}</strong>
        </div>
        <div>Total: <strong>${stat.total}</strong> contributions</div>
        ${comparisonHtml}
      `;
      
      // Add hover tooltip for the user's line
      polyline.addEventListener('mouseenter', () => {
        // Highlight this line, dim others
        svg.querySelectorAll('.sparkline-path').forEach(p => p.classList.add('dimmed'));
        polyline.classList.remove('dimmed');
      });
      
      polyline.addEventListener('mousemove', (e) => {
        const rect = statsGraphContainer.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        graphTooltip.innerHTML = tooltipHtml;
        graphTooltip.style.left = `${x + 10}px`;
        graphTooltip.style.top = `${y - 10}px`;
        graphTooltip.style.opacity = '1';
      });
      
      polyline.addEventListener('mouseleave', () => {
        svg.querySelectorAll('.sparkline-path').forEach(p => p.classList.remove('dimmed'));
        graphTooltip.style.opacity = '0';
      });
      
      g.appendChild(polyline);
    });

    statsGraphContainer.appendChild(svg);

  } catch (err) {
    statsGraphContainer.innerHTML = '<div class="no-data">Failed to load statistics.</div>';
    console.error(err);
  }
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

// Stats button
if (btnStats) {
  btnStats.addEventListener('click', () => {
    statsPanel.classList.add('visible');
    renderStats();
  });
}
if (btnCancelStats) {
  btnCancelStats.addEventListener('click', () => {
    statsPanel.classList.remove('visible');
  });
}

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
    if (statsPanel && statsPanel.classList.contains('visible')) {
      statsPanel.classList.remove('visible');
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
