/**
 * renderer.js — UI logic for the GitHub Contribution Widget
 * Runs in the Electron renderer process with contextIsolation.
 * Communicates with main process via the `window.api` bridge.
 */

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

// ── State ───────────────────────────────────────────────────────
let currentData = null;

// ── Month names ─────────────────────────────────────────────────
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── Initialization ──────────────────────────────────────────────
async function init() {
  // Load cached data first for instant display
  const cached = await window.api.getData();
  if (cached && cached.weeks && cached.weeks.length > 0) {
    currentData = cached;
    renderGraph(cached.weeks);
    updateStatus(cached);
  } else {
    showNoData();
  }

  // Load config and populate settings
  const config = await window.api.getConfig();
  inputUsername.value = config.username || '';
  inputToken.value = config.token || '';

  if (config.username) {
    titleText.textContent = `${config.username}'s contributions`;
  }

  // If we have a username, fetch fresh data once
  if (config.username) {
    await refreshData();
  }
}

// ── Data Fetching ───────────────────────────────────────────────
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
    setStatus(`Fetch failed: ${err.message}`, true);
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

      // Tooltip events
      cell.addEventListener('mouseenter', (e) => showTooltip(e, day));
      cell.addEventListener('mouseleave', hideTooltip);

      col.appendChild(cell);
    });

    graphGrid.appendChild(col);
  });
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

  monthPositions.forEach((mp, i) => {
    const label = document.createElement('span');
    label.className = 'month-label';
    label.textContent = MONTH_NAMES[mp.month];

    // Calculate width until next month
    const nextIndex = i + 1 < monthPositions.length ? monthPositions[i + 1].index : weeks.length;
    const span = nextIndex - mp.index;
    label.style.width = `${span * cellSize}px`;
    label.style.minWidth = `${span * cellSize}px`;

    monthsRow.appendChild(label);
  });
}

// ── Tooltip ─────────────────────────────────────────────────────
function showTooltip(event, day) {
  const count = day.count;
  const dateStr = formatDate(day.date);
  const plural = count === 1 ? 'contribution' : 'contributions';

  tooltip.innerHTML = `<span class="tip-count">${count} ${plural}</span><span class="tip-date">on ${dateStr}</span>`;

  // Position tooltip above the cell
  const cellRect = event.target.getBoundingClientRect();
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
  const options = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
  return date.toLocaleDateString('en-US', options);
}

// ── Status ──────────────────────────────────────────────────────
function updateStatus(data) {
  if (data.lastFetched) {
    const date = new Date(data.lastFetched);
    const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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

// ── Event Listeners ─────────────────────────────────────────────

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

  if (!username) {
    inputUsername.style.borderColor = '#f85149';
    inputUsername.focus();
    return;
  }

  inputUsername.style.borderColor = '';

  await window.api.saveConfig({ username, token });
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

// Escape to close settings
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (settingsPanel.classList.contains('visible')) {
      closeSettings();
    }
  }
});

// Listen for tray-triggered refresh
window.api.onTriggerRefresh(() => {
  refreshData();
});

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
