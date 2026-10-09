/**
 * renderer.js — UI logic for the GitHub Contribution Widget.
 * Runs in the main widget window and in every "versus" window.
 */
'use strict';

const S = window.WidgetStats;
const { escapeHtml, formatNumber } = S;

// ── Tauri bridge ────────────────────────────────────────────────
const TAURI = window.__TAURI__;
const { invoke } = TAURI.core;
const { listen, emit } = TAURI.event;
const currentWindow = TAURI.webviewWindow.getCurrentWebviewWindow();

const api = {
  getConfig: () => invoke('get_config'),
  updateConfig: (patch) => invoke('update_config', { patch }),
  getData: (username) => invoke('get_data', { username }),
  fetchContributions: (force) => invoke('fetch_contributions', { force }),
  fetchUser: (username, force) => invoke('fetch_user_contributions', { username, force }),
  refreshAll: () => invoke('refresh_all_data'),
  openVersus: (username) => invoke('open_versus_window', { username }),
  removeFromHistory: (username) => invoke('remove_from_versus_history', { username }),
  closeAllVersus: () => invoke('close_all_versus'),
  minimizeToTray: () => invoke('minimize_to_tray'),
  fitWindow: (width, height) => invoke('fit_window', { width, height }),
  openExternal: (url) => invoke('open_external', { url }),
  savePng: (fileName, dataBase64) => invoke('save_png', { fileName, dataBase64 }),
};

// ── Themes (single source of truth for CSS, charts and PNG export) ──
const THEMES = {
  green:     { name: 'GitHub green', colors: ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'] },
  blue:      { name: 'Blue',     vibrant: true, colors: ['#161b22', '#183a6b', '#265a9e', '#3d81d6', '#58a6ff'] },
  purple:    { name: 'Purple',   vibrant: true, colors: ['#161b22', '#3c1e70', '#5d30a6', '#824ee1', '#a371f7'] },
  pink:      { name: 'Pink',     vibrant: true, colors: ['#161b22', '#612143', '#943265', '#ca488b', '#f778ba'] },
  orange:    { name: 'Orange',   vibrant: true, colors: ['#161b22', '#5e2908', '#96430d', '#d25d12', '#ff7b24'] },
  yellow:    { name: 'Yellow',   vibrant: true, colors: ['#161b22', '#584411', '#8a6b1a', '#bb9125', '#e3b341'] },
  coral:     { name: 'Coral',    vibrant: true, colors: ['#161b22', '#5e2221', '#923533', '#c54947', '#f06461'] },
  cyan:      { name: 'Cyan',     vibrant: true, colors: ['#161b22', '#0d484d', '#15737a', '#24a1ab', '#39c5cf'] },
  teal:      { name: 'Teal',     vibrant: true, colors: ['#161b22', '#0c392c', '#155a46', '#1f7d61', '#2b9a7c'] },
  magenta:   { name: 'Magenta',  vibrant: true, colors: ['#161b22', '#511d44', '#7e2e6b', '#a94390', '#d258b3'] },
  indigo:    { name: 'Indigo',   vibrant: true, colors: ['#161b22', '#2a2e6e', '#4249a1', '#5e66ce', '#7982f6'] },
  halloween: { name: 'Halloween', colors: ['#161b22', '#631c03', '#bd561d', '#fa7a18', '#fddf68'] },
  mono:      { name: 'Monochrome', colors: ['#161b22', '#373e47', '#545d68', '#909dab', '#cdd9e5'] },
};

const GRAPH_COLORS = ['#39d353', '#58a6ff', '#e3b341', '#a371f7', '#f06461', '#ff7b72', '#d2a8ff', '#79c0ff', '#ffa657', '#fa4549', '#39c5cf'];

const QUOTES = [
  { text: 'Talk is cheap. Show me the code.', author: 'Linus Torvalds' },
  { text: 'Programs must be written for people to read.', author: 'Harold Abelson' },
  { text: 'First, solve the problem. Then, write the code.', author: 'John Johnson' },
  { text: 'Any fool can write code that a computer can understand.', author: 'Martin Fowler' },
  { text: "It's fine to celebrate success but heed the lessons of failure.", author: 'Bill Gates' },
  { text: 'Move fast and break things.', author: 'Mark Zuckerberg' },
  { text: "I'm gonna make him an offer he can't refuse.", author: 'The Godfather' },
  { text: 'Do, or do not. There is no try.', author: 'Yoda' },
  { text: 'I am Iron Man.', author: 'Tony Stark' },
  { text: "Code is like humor. When you have to explain it, it's bad.", author: 'Cory House' },
  { text: 'Stay hungry, stay foolish.', author: 'Steve Jobs' },
  { text: 'May the Force be with you.', author: 'Star Wars' },
];

// ── DOM ─────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const widget = $('widget');
const graphGrid = $('graphGrid');
const monthsRow = $('monthsRow');
const tooltip = $('tooltip');
const statusText = $('statusText');
const titleText = $('titleText');
const titleTotal = $('titleTotal');
const statsStrip = $('statsStrip');
const loadingOverlay = $('loadingOverlay');
const btnRefresh = $('btnRefresh');
const toastEl = $('toast');

// ── Mode & state ────────────────────────────────────────────────
const versusUser = window.__VERSUS_USER__
  || (currentWindow.label.startsWith('versus_') ? currentWindow.label.slice('versus_'.length) : null);
const isVersus = Boolean(versusUser);

const state = {
  config: null,
  displayUser: null,
  data: null,
  stats: null,
  mainStats: null, // main user's stats, used for head-to-head in versus windows
  renderKey: null,
  busy: false,
  error: null,
  theme: 'green',
  draft: null, // settings being edited
};

const todayISO = () => S.toISODate(new Date());
const errText = (err) => (typeof err === 'string' ? err : (err && err.message) || 'Unknown error');
const sameUser = (a, b) => Boolean(a && b) && a.toLowerCase() === b.toLowerCase();

// ── Appearance ──────────────────────────────────────────────────
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function versusTheme(username, mainTheme) {
  const options = Object.keys(THEMES).filter((t) => THEMES[t].vibrant && t !== mainTheme);
  const hash = username.toLowerCase().split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return options[hash % options.length];
}

function applyTheme(themeId) {
  const theme = THEMES[themeId] || THEMES.green;
  state.theme = THEMES[themeId] ? themeId : 'green';
  const root = document.documentElement.style;
  theme.colors.forEach((c, i) => root.setProperty(`--l${i}`, c));
  root.setProperty('--accent', theme.colors[4]);
  root.setProperty('--accent-rgb', hexToRgb(theme.colors[4]));
}

function applyOpacity(percent) {
  const alpha = Math.max(0, Math.min(100, Number(percent))) / 100;
  document.documentElement.style.setProperty('--bg-alpha', String(alpha));
}

function applyConfig(cfg) {
  applyOpacity(cfg.opacity);
  applyTheme(isVersus ? versusTheme(versusUser, cfg.theme) : cfg.theme);
  widget.classList.toggle('hide-quotes', !cfg.show_quotes);
  widget.classList.toggle('hide-stats', !cfg.show_stats);
}

// ── Window sizing ───────────────────────────────────────────────
let fitScheduled = false;
function scheduleFit() {
  if (fitScheduled) return;
  fitScheduled = true;
  requestAnimationFrame(() => {
    fitScheduled = false;
    const rect = widget.getBoundingClientRect();
    api.fitWindow(rect.width + 16, rect.height + 16).catch(() => {});
  });
}
new ResizeObserver(scheduleFit).observe(widget);

// ── Toast ───────────────────────────────────────────────────────
let toastTimer = null;
function showToast(message, tone = '') {
  toastEl.textContent = message;
  toastEl.title = message;
  toastEl.className = `toast visible ${tone}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('visible'), tone === 'error' ? 6000 : 3500);
}

// ── Graph rendering ─────────────────────────────────────────────
function renderGraph(weeks) {
  const displayWeeks = weeks.slice(-53);
  const today = todayISO();
  const parts = [];

  displayWeeks.forEach((week, i) => {
    // Pad the first (partial) week so day rows line up with weekday labels.
    if (i === 0 && week.length < 7) {
      const firstWeekday = S.parseISODate(week[0].date).getDay();
      for (let p = 0; p < firstWeekday; p++) parts.push('<div class="day-cell empty"></div>');
    }
    for (const day of week) {
      const cls = day.date === today ? 'day-cell today' : 'day-cell';
      parts.push(`<div class="${cls}" data-level="${day.level | 0}" data-date="${day.date}" data-count="${day.count | 0}"></div>`);
    }
    // Pad a trailing partial week so the grid stays rectangular.
    if (i === displayWeeks.length - 1 && week.length < 7 && i !== 0) {
      for (let p = week.length; p < 7; p++) parts.push('<div class="day-cell empty"></div>');
    }
  });

  graphGrid.innerHTML = parts.join('');

  const cellSpan = 14; // 11px cell + 3px gap
  monthsRow.innerHTML = S.monthLabels(displayWeeks)
    .map((m) => `<span class="month-label" style="width:${m.span * cellSpan}px;min-width:${m.span * cellSpan}px">${m.span >= 2 ? m.name : ''}</span>`)
    .join('');
}

function showNoData(message) {
  monthsRow.innerHTML = '';
  titleTotal.textContent = '';
  statsStrip.innerHTML = '';
  state.renderKey = null;
  if (isVersus) {
    graphGrid.innerHTML = `<div class="no-data">${escapeHtml(message || 'No data available.')}</div>`;
  } else if (!state.config || !state.config.username) {
    graphGrid.innerHTML = '<div class="no-data">No data yet. <button data-action="open-settings">Configure your username</button> to get started.</div>';
  } else {
    graphGrid.innerHTML = `<div class="no-data">${escapeHtml(message || 'No data yet.')} <button data-action="refresh">Try again</button></div>`;
  }
}

function showData(data) {
  if (!data || !data.weeks || data.weeks.length === 0) return;
  state.data = data;
  state.error = null;
  const key = `${data.username}|${data.lastFetched}|${data.weeks.length}`;
  if (key !== state.renderKey) {
    renderGraph(data.weeks);
    state.renderKey = key;
  }
  state.stats = S.computeStats(data.weeks, todayISO());
  if (!isVersus) state.mainStats = state.stats;
  renderTitle();
  renderStatsStrip();
  updateStatus();
}

function renderTitle() {
  const user = state.displayUser;
  titleText.textContent = user ? `${user}'s contributions` : 'Contributions';
  titleTotal.innerHTML = state.stats
    ? `· <strong>${formatNumber(state.stats.total)}</strong> in the last year`
    : '';
}

function renderStatsStrip() {
  const s = state.stats;
  if (!s) { statsStrip.innerHTML = ''; return; }
  const items = [
    `<span class="stat" title="Current streak">🔥 <strong>${s.currentStreak}</strong> day streak</span>`,
    `<span class="stat" title="Longest streak in the last year">🏆 <strong>${s.longestStreak}</strong> best</span>`,
  ];

  const goal = state.config ? state.config.daily_goal : 0;
  if (!isVersus && goal > 0) {
    const pct = Math.min(100, Math.round((s.today / goal) * 100));
    items.push(`<span class="stat goal ${s.today >= goal ? 'done' : ''}" title="Daily goal">${s.today >= goal ? '🎯' : '⚡'} Today <strong>${s.today}/${goal}</strong><span class="goal-bar"><span style="width:${pct}%"></span></span></span>`);
  } else {
    items.push(`<span class="stat" title="Contributions today">⚡ <strong>${s.today}</strong> today</span>`);
  }

  if (isVersus && state.mainStats && state.config && state.config.username) {
    const diff = s.total - state.mainStats.total;
    if (diff === 0) items.push('<span class="stat" title="Head-to-head (last year)">⚔️ <strong>Tied</strong> with you</span>');
    else if (diff > 0) items.push(`<span class="stat bad" title="Head-to-head (last year)">⚔️ <strong>+${formatNumber(diff)}</strong> ahead of you</span>`);
    else items.push(`<span class="stat good" title="Head-to-head (last year)">⚔️ You lead by <strong>${formatNumber(-diff)}</strong></span>`);
  } else if (s.maxDay && s.maxDay.count > 0) {
    items.push(`<span class="stat" title="Best day: ${escapeHtml(formatDate(s.maxDay.date))}">⭐ <strong>${s.maxDay.count}</strong> best day</span>`);
  }

  statsStrip.innerHTML = items.join('');
}

// ── Status line ─────────────────────────────────────────────────
const dateFormatter = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const fullTimeFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const formatDate = (iso) => dateFormatter.format(S.parseISODate(iso));

function updateStatus() {
  statusText.classList.remove('stale', 'error');
  if (state.busy) {
    statusText.textContent = 'Refreshing…';
    statusText.title = '';
    return;
  }
  if (state.error) {
    statusText.textContent = state.data ? `⚠ ${state.error}` : state.error;
    statusText.title = state.error;
    statusText.classList.add('error');
    return;
  }
  if (!state.data || !state.data.lastFetched) {
    statusText.textContent = 'Ready';
    statusText.title = '';
    return;
  }
  const fetched = new Date(state.data.lastFetched);
  statusText.textContent = `Updated ${S.relativeTime(state.data.lastFetched)}`;
  statusText.title = `Last updated ${fullTimeFormatter.format(fetched)}`;
  const interval = state.config ? state.config.refresh_interval : 0;
  const staleAfter = (interval > 0 ? interval * 2 : 24 * 60) * 60 * 1000;
  if (Date.now() - fetched.getTime() > staleAfter) statusText.classList.add('stale');
}

function setBusy(busy) {
  state.busy = busy;
  btnRefresh.classList.toggle('spinning', busy);
  updateStatus();
}

setInterval(updateStatus, 30 * 1000);

// ── Data loading ────────────────────────────────────────────────
async function loadData(force) {
  if (!state.displayUser) { showNoData(); return; }
  const firstLoad = !state.data;
  if (firstLoad) loadingOverlay.classList.add('visible');
  setBusy(true);
  try {
    const data = isVersus
      ? await api.fetchUser(state.displayUser, force)
      : await api.fetchContributions(force);
    showData(data);
  } catch (err) {
    state.error = errText(err);
    if (!state.data) showNoData(state.error);
    else if (force) showToast(state.error, 'error');
  } finally {
    loadingOverlay.classList.remove('visible');
    setBusy(false);
  }
}

async function loadMainStatsForVersus() {
  if (!isVersus || !state.config.username) return;
  try {
    const main = await api.getData(state.config.username);
    if (main) {
      state.mainStats = S.computeStats(main.weeks, todayISO());
      renderStatsStrip();
    }
  } catch (_) { /* head-to-head is optional */ }
}

// ── Tooltip & day clicks ────────────────────────────────────────
function showTooltip(cell) {
  const count = Number(cell.dataset.count);
  const plural = count === 1 ? 'contribution' : 'contributions';
  tooltip.innerHTML = `<span class="tip-count">${count === 0 ? 'No' : count} ${plural}</span><span class="tip-date">on ${escapeHtml(formatDate(cell.dataset.date))}</span>`;

  const cellRect = cell.getBoundingClientRect();
  const widgetRect = widget.getBoundingClientRect();
  tooltip.classList.add('visible');
  const tipWidth = tooltip.offsetWidth;
  const tipHeight = tooltip.offsetHeight;
  // Keep the tooltip inside the widget (it's clipped by the rounded card).
  let left = cellRect.left - widgetRect.left + cellRect.width / 2 - tipWidth / 2;
  left = Math.max(6, Math.min(left, widgetRect.width - tipWidth - 6));
  let top = cellRect.top - widgetRect.top - tipHeight - 8;
  if (top < 4) top = cellRect.bottom - widgetRect.top + 8;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

graphGrid.addEventListener('mouseover', (e) => {
  const cell = e.target.closest('.day-cell');
  if (cell && !cell.classList.contains('empty')) showTooltip(cell);
});
graphGrid.addEventListener('mouseleave', () => tooltip.classList.remove('visible'));
graphGrid.addEventListener('click', (e) => {
  const cell = e.target.closest('.day-cell');
  if (cell && !cell.classList.contains('empty') && state.displayUser) {
    const date = cell.dataset.date;
    api.openExternal(`https://github.com/${encodeURIComponent(state.displayUser)}?tab=overview&from=${date}&to=${date}`)
      .catch((err) => showToast(errText(err), 'error'));
  }
});

// Delegated actions (no-data links etc.)
widget.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]');
  if (!action) return;
  if (action.dataset.action === 'open-settings') openSettings();
  if (action.dataset.action === 'refresh') loadData(true);
});

// ── Dragging ────────────────────────────────────────────────────
widget.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || (state.config && state.config.lock_position)) return;
  if (!e.target.closest('.drag-zone') || e.target.closest('button, input, select, a, .panel')) return;
  e.preventDefault();
  currentWindow.startDragging().catch(() => {});
});

// ── Quote ticker ────────────────────────────────────────────────
function renderQuotes() {
  const shuffled = [...QUOTES].sort(() => 0.5 - Math.random());
  const html = shuffled
    .map((q) => `<div class="quote-item">"${escapeHtml(q.text)}" <span class="author">— ${escapeHtml(q.author)}</span></div>`)
    .join('');
  $('quoteTicker').innerHTML = html + html; // duplicated for a seamless loop
}

// Pause marquee animations whenever the widget can't be seen.
document.addEventListener('visibilitychange', () => {
  widget.classList.toggle('paused', document.hidden);
});

// ── Panels ──────────────────────────────────────────────────────
const panels = ['settingsPanel', 'vsPanel', 'statsPanel'];

function openPanel(id) {
  panels.forEach((p) => { if (p !== id) $(p).classList.remove('visible'); });
  $(id).classList.add('visible');
  tooltip.classList.remove('visible');
}

function closePanel(id) {
  const panel = $(id);
  if (!panel.classList.contains('visible')) return;
  if (id === 'settingsPanel') cancelSettings();
  panel.classList.remove('visible');
}

const openPanelId = () => panels.find((p) => $(p).classList.contains('visible'));

document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => closePanel(btn.dataset.close));
});

function selectTab(group, tab) {
  const nav = document.querySelector(`[data-tabs="${group}"]`);
  nav.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  const panel = nav.closest('.panel');
  panel.querySelectorAll('.tab-page').forEach((p) => p.classList.toggle('active', p.dataset.page === tab));
}

document.querySelectorAll('[data-tabs]').forEach((nav) => {
  nav.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    selectTab(nav.dataset.tabs, tab.dataset.tab);
    if (nav.dataset.tabs === 'stats' && tab.dataset.tab === 'insights') renderInsights();
  });
});

// ── Settings ────────────────────────────────────────────────────
const inputUsername = $('inputUsername');
const inputToken = $('inputToken');
const inputOpacity = $('inputOpacity');
const inputShortcut = $('inputShortcut');
const inputGoal = $('inputGoal');
const selectInterval = $('selectInterval');
const selectReminderHour = $('selectReminderHour');
const settingsError = $('settingsError');

(function buildStaticControls() {
  $('themeSwatches').innerHTML = Object.entries(THEMES)
    .map(([id, t]) => `<button type="button" class="swatch" data-theme="${id}" title="${t.name}" style="background:linear-gradient(90deg, ${t.colors[1]}, ${t.colors[2]}, ${t.colors[3]}, ${t.colors[4]})"></button>`)
    .join('');
  const hourFormatter = new Intl.DateTimeFormat('en-US', { hour: 'numeric' });
  selectReminderHour.innerHTML = Array.from({ length: 24 }, (_, h) => {
    const label = hourFormatter.format(new Date(2000, 0, 1, h));
    return `<option value="${h}">After ${label}</option>`;
  }).join('');
})();

function renderDraft() {
  const d = state.draft;
  inputOpacity.value = d.opacity;
  $('opacityValue').textContent = `${d.opacity}%`;
  document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s.dataset.theme === d.theme));
  document.querySelectorAll('#layerControl button').forEach((b) => b.classList.toggle('active', b.dataset.value === d.window_layer));
  inputShortcut.value = S.prettyShortcut(d.shortcut);
  $('dataSourceHint').textContent = inputToken.value.trim()
    ? 'GitHub GraphQL API (token) — exact counts, includes private activity you share'
    : 'Public profile page (no token) — may be rate limited';
}

function openSettings() {
  if (isVersus || !state.config) return;
  state.draft = { ...state.config };
  const d = state.draft;
  inputUsername.value = d.username;
  inputUsername.classList.remove('invalid');
  inputToken.value = d.token;
  inputToken.type = 'password';
  selectInterval.value = String(d.refresh_interval);
  if (selectInterval.value !== String(d.refresh_interval)) selectInterval.value = '60';
  $('toggleStats').checked = d.show_stats;
  $('toggleQuotes').checked = d.show_quotes;
  $('toggleStartup').checked = d.launch_at_startup;
  $('toggleLock').checked = d.lock_position;
  $('toggleReminder').checked = d.reminder_enabled;
  inputGoal.value = d.daily_goal;
  selectReminderHour.value = String(d.reminder_hour);
  settingsError.textContent = '';
  renderDraft();
  selectTab('settings', 'account');
  openPanel('settingsPanel');
  inputUsername.focus();
}

function cancelSettings() {
  // Revert live previews (opacity / theme).
  if (state.config) {
    applyConfig(state.config);
    emit('opacity-preview', state.config.opacity).catch(() => {});
  }
  state.draft = null;
}

async function saveSettings() {
  if (!state.draft) return;
  const username = inputUsername.value.trim().replace(/^@/, '');
  if (!username) {
    inputUsername.classList.add('invalid');
    selectTab('settings', 'account');
    inputUsername.focus();
    settingsError.textContent = 'A GitHub username is required.';
    return;
  }
  const patch = {
    username,
    token: inputToken.value.trim(),
    refresh_interval: Number(selectInterval.value),
    opacity: Number(inputOpacity.value),
    theme: state.draft.theme,
    show_stats: $('toggleStats').checked,
    show_quotes: $('toggleQuotes').checked,
    window_layer: state.draft.window_layer,
    shortcut: state.draft.shortcut,
    launch_at_startup: $('toggleStartup').checked,
    lock_position: $('toggleLock').checked,
    daily_goal: Math.max(0, Math.min(500, Math.round(Number(inputGoal.value) || 0))),
    reminder_enabled: $('toggleReminder').checked,
    reminder_hour: Number(selectReminderHour.value),
  };

  const btn = $('btnSaveSettings');
  btn.disabled = true;
  settingsError.textContent = '';
  try {
    const previous = state.config;
    const saved = await api.updateConfig(patch);
    state.draft = null;
    $('settingsPanel').classList.remove('visible');
    onConfigChanged(saved);
    const accountChanged = !sameUser(previous.username, saved.username) || previous.token !== saved.token;
    if (accountChanged) {
      state.data = null;
      state.stats = null;
      state.renderKey = null;
      graphGrid.innerHTML = '';
      loadData(true);
    }
    showToast('Settings saved', 'success');
  } catch (err) {
    settingsError.textContent = errText(err);
    if (/username/i.test(errText(err))) {
      inputUsername.classList.add('invalid');
      selectTab('settings', 'account');
    }
  } finally {
    btn.disabled = false;
  }
}

inputOpacity.addEventListener('input', () => {
  const val = Number(inputOpacity.value);
  if (state.draft) state.draft.opacity = val;
  $('opacityValue').textContent = `${val}%`;
  applyOpacity(val);
  emit('opacity-preview', val).catch(() => {});
});

$('themeSwatches').addEventListener('click', (e) => {
  const swatch = e.target.closest('.swatch');
  if (!swatch || !state.draft) return;
  state.draft.theme = swatch.dataset.theme;
  applyTheme(state.draft.theme);
  renderDraft();
});

$('layerControl').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || !state.draft) return;
  state.draft.window_layer = btn.dataset.value;
  renderDraft();
});

$('toggleStats').addEventListener('change', (e) => widget.classList.toggle('hide-stats', !e.target.checked));
$('toggleQuotes').addEventListener('change', (e) => widget.classList.toggle('hide-quotes', !e.target.checked));

inputShortcut.addEventListener('focus', () => {
  inputShortcut.classList.add('capturing');
  inputShortcut.value = 'Press a key combination…';
});
inputShortcut.addEventListener('blur', () => {
  inputShortcut.classList.remove('capturing');
  if (state.draft) inputShortcut.value = S.prettyShortcut(state.draft.shortcut);
});
inputShortcut.addEventListener('keydown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape' || e.key === 'Tab') { inputShortcut.blur(); return; }
  const spec = S.shortcutFromEvent(e);
  if (spec && state.draft) {
    state.draft.shortcut = spec;
    inputShortcut.blur();
  }
});
$('btnClearShortcut').addEventListener('click', () => {
  if (!state.draft) return;
  state.draft.shortcut = '';
  renderDraft();
});

$('btnToggleToken').addEventListener('click', () => {
  inputToken.type = inputToken.type === 'password' ? 'text' : 'password';
});
inputToken.addEventListener('input', renderDraft);
inputUsername.addEventListener('input', () => inputUsername.classList.remove('invalid'));
$('btnGetToken').addEventListener('click', () => {
  api.openExternal('https://github.com/settings/tokens/new?description=GitHub%20Contribution%20Widget&scopes=read:user')
    .catch((err) => showToast(errText(err), 'error'));
});

[inputUsername, inputToken, inputGoal].forEach((input) => {
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSettings(); });
});
$('btnSaveSettings').addEventListener('click', saveSettings);
$('btnCancelSettings').addEventListener('click', () => closePanel('settingsPanel'));

$('btnRefreshAll').addEventListener('click', refreshAll);

async function refreshAll() {
  setBusy(true);
  try {
    const summary = await api.refreshAll();
    if (summary.failed.length) showToast(`Refreshed ${summary.refreshed}; failed: ${summary.failed.join('; ')}`, 'error');
    else showToast(`Refreshed ${summary.refreshed} profile${summary.refreshed === 1 ? '' : 's'}`, 'success');
  } catch (err) {
    showToast(errText(err), 'error');
  } finally {
    setBusy(false);
  }
}

// ── Versus panel ────────────────────────────────────────────────
const inputVsUser = $('inputVsUser');

function parseUserList(raw) {
  const seen = new Set();
  return raw.split(/[\s,]+/)
    .map((u) => u.trim().replace(/^@/, ''))
    .filter((u) => u && !seen.has(u.toLowerCase()) && seen.add(u.toLowerCase()))
    .slice(0, 10);
}

function renderVsHistory() {
  const history = (state.config && state.config.versus_history) || [];
  const selected = new Set(parseUserList(inputVsUser.value).map((u) => u.toLowerCase()));
  $('vsHistory').innerHTML = history.length
    ? history.map((u) => `<span class="chip ${selected.has(u.toLowerCase()) ? 'selected' : ''}"><button class="chip-name" data-user="${escapeHtml(u)}">${escapeHtml(u)}</button><button class="chip-remove" data-remove="${escapeHtml(u)}" title="Remove from history">×</button></span>`).join('')
    : '<span class="empty-hint">Users you compare against will show up here.</span>';
}

function openVersusPanel() {
  if (isVersus) return;
  $('vsError').textContent = '';
  renderVsHistory();
  openPanel('vsPanel');
  inputVsUser.focus();
}

$('vsHistory').addEventListener('click', async (e) => {
  const add = e.target.closest('[data-user]');
  const remove = e.target.closest('[data-remove]');
  if (add) {
    const users = parseUserList(inputVsUser.value);
    const name = add.dataset.user;
    const idx = users.findIndex((u) => sameUser(u, name));
    if (idx >= 0) users.splice(idx, 1); else users.push(name);
    inputVsUser.value = users.join(', ');
    renderVsHistory();
  } else if (remove) {
    try {
      onConfigChanged(await api.removeFromHistory(remove.dataset.remove));
      renderVsHistory();
    } catch (err) {
      $('vsError').textContent = errText(err);
    }
  }
});

inputVsUser.addEventListener('input', renderVsHistory);
inputVsUser.addEventListener('keydown', (e) => { if (e.key === 'Enter') startVersus(); });
$('btnStartVs').addEventListener('click', startVersus);

async function startVersus() {
  const users = parseUserList(inputVsUser.value)
    .filter((u) => !sameUser(u, state.config.username));
  if (users.length === 0) {
    inputVsUser.classList.add('invalid');
    $('vsError').textContent = 'Enter at least one other GitHub username.';
    inputVsUser.focus();
    return;
  }
  inputVsUser.classList.remove('invalid');
  const btn = $('btnStartVs');
  btn.disabled = true;
  const failed = [];
  for (const user of users) {
    try {
      await api.openVersus(user);
    } catch (err) {
      failed.push(`${user} (${errText(err)})`);
    }
  }
  btn.disabled = false;
  if (failed.length) {
    $('vsError').textContent = `Couldn't open: ${failed.join(', ')}`;
    return;
  }
  inputVsUser.value = '';
  $('vsPanel').classList.remove('visible');
}

$('btnCloseAllVs').addEventListener('click', async () => {
  try {
    await api.closeAllVersus();
    $('vsPanel').classList.remove('visible');
  } catch (err) {
    $('vsError').textContent = errText(err);
  }
});

// ── Stats panel: leaderboard + insights ─────────────────────────
const statsGraphContainer = $('statsGraphContainer');
const graphTooltip = $('graphTooltip');
let leaderboardToken = 0;

function leaderboardUsers() {
  const cfg = state.config;
  const users = [];
  const push = (u) => { if (u && !users.some((x) => sameUser(x, u))) users.push(u); };
  if (isVersus) push(versusUser);
  push(cfg.username);
  (cfg.open_versus || []).forEach(push);
  (cfg.versus_history || []).forEach(push);
  return users.slice(0, 12);
}

async function openStats() {
  selectTab('stats', 'leaderboard'); // the chart is sized from its visible box
  openPanel('statsPanel');
  $('statsTitle').textContent = isVersus ? `${versusUser} vs. the field` : 'Stats';
  renderInsights();
  await renderLeaderboard();
}

async function renderLeaderboard() {
  const token = ++leaderboardToken;
  statsGraphContainer.innerHTML = '<div class="no-data">Calculating statistics…</div>';
  $('rankList').innerHTML = '';
  $('statsTicker').innerHTML = '';

  const users = leaderboardUsers();
  if (users.length === 0) {
    statsGraphContainer.innerHTML = '<div class="no-data">No developers configured yet.</div>';
    return;
  }

  // Fetch everyone in parallel; the backend serves fresh caches instantly
  // and limits concurrent GitHub requests.
  const results = await Promise.allSettled(users.map((u) => api.fetchUser(u, false)));
  if (token !== leaderboardToken) return; // a newer render superseded this one

  const stats = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value && r.value.weeks) {
      stats.push({ username: users[i], ...S.computeStats(r.value.weeks, todayISO()) });
    } else {
      failed.push(users[i]);
    }
  });

  if (stats.length === 0) {
    statsGraphContainer.innerHTML = '<div class="no-data">Failed to load statistics.</div>';
    return;
  }

  stats.sort((a, b) => b.total - a.total);
  stats.forEach((s, i) => { s.color = GRAPH_COLORS[i % GRAPH_COLORS.length]; });

  renderRankList(stats);
  renderTicker(stats);
  renderSparklines(stats);
  if (failed.length) showToast(`Couldn't load: ${failed.join(', ')}`, 'error');
}

function isMe(user) {
  return state.config && sameUser(user, state.config.username);
}

function renderRankList(stats) {
  $('rankList').innerHTML = stats.map((s, i) => {
    const m = S.formatMomentum(s.momentum);
    const me = isMe(s.username);
    return `<div class="rank-row ${me ? 'me' : 'clickable'}" data-user="${escapeHtml(s.username)}" title="${me ? 'You' : 'Open versus window'}">
      <span class="rank">${i + 1}</span>
      <span class="dot" style="background:${s.color}"></span>
      <span class="name">${escapeHtml(s.username)}${me ? ' <em>(you)</em>' : ''}</span>
      <span class="num">${formatNumber(s.total)}</span>
      <span class="streak">🔥${s.currentStreak}</span>
      <span class="mom tone-${m.tone}">${escapeHtml(m.text)}</span>
    </div>`;
  }).join('');
}

$('rankList').addEventListener('click', (e) => {
  const row = e.target.closest('.rank-row.clickable');
  if (row && !isVersus) api.openVersus(row.dataset.user).catch((err) => showToast(errText(err), 'error'));
});
$('rankList').addEventListener('mouseover', (e) => {
  const row = e.target.closest('.rank-row');
  focusSeries(row ? row.dataset.user : null);
});
$('rankList').addEventListener('mouseleave', () => focusSeries(null));

function renderTicker(stats) {
  const html = stats.map((s) => {
    const m = S.formatMomentum(s.momentum);
    return `<div class="ticker-item"><span class="color-dot" style="background:${s.color}"></span><strong>${escapeHtml(s.username)}</strong><span class="total">${formatNumber(s.total)} total</span><span class="streak">🔥 ${s.currentStreak} day streak</span><span class="momentum tone-${m.tone}">${escapeHtml(m.text)}</span></div>`;
  }).join('');
  $('statsTicker').innerHTML = html + html;
}

function focusSeries(user) {
  statsGraphContainer.querySelectorAll('.sparkline-path').forEach((p) => {
    const match = user && sameUser(p.dataset.user, user);
    p.classList.toggle('dimmed', Boolean(user) && !match);
    p.classList.toggle('focused', Boolean(match));
  });
  $('rankList').querySelectorAll('.rank-row').forEach((r) => r.classList.toggle('focused', Boolean(user) && sameUser(r.dataset.user, user)));
}

function renderSparklines(stats) {
  const box = statsGraphContainer.getBoundingClientRect();
  const W = Math.max(200, box.width);
  const H = Math.max(80, box.height);
  const pad = { l: 26, r: 8, t: 8, b: 16 };
  const days = Math.max(...stats.map((s) => s.last30.length));
  // Scale to the busiest day *within the 30-day window* so lines aren't squashed.
  const yMax = Math.max(4, ...stats.map((s) => Math.max(0, ...s.last30.map((d) => d.count))));
  const x = (i) => pad.l + (days <= 1 ? 0 : (i / (days - 1)) * (W - pad.l - pad.r));
  const y = (v) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b);

  const ticks = [0, Math.round(yMax / 2), yMax];
  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`;
  ticks.forEach((t) => {
    svg += `<line class="chart-grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/>`;
    svg += `<text class="chart-axis" x="${pad.l - 5}" y="${y(t) + 3}" text-anchor="end">${t}</text>`;
  });
  const ref = stats.reduce((a, b) => (b.last30.length > a.last30.length ? b : a)).last30;
  if (ref.length) {
    const fmt = (iso) => S.MONTH_NAMES[S.parseISODate(iso).getMonth()] + ' ' + S.parseISODate(iso).getDate();
    svg += `<text class="chart-axis" x="${pad.l}" y="${H - 4}">${fmt(ref[0].date)}</text>`;
    svg += `<text class="chart-axis" x="${W - pad.r}" y="${H - 4}" text-anchor="end">${fmt(ref[ref.length - 1].date)}</text>`;
  }
  // Draw the leader last so it sits on top.
  [...stats].reverse().forEach((s) => {
    const offset = days - s.last30.length;
    const points = s.last30.map((d, i) => `${x(i + offset).toFixed(1)},${y(d.count).toFixed(1)}`).join(' ');
    svg += `<polyline class="sparkline-path" data-user="${escapeHtml(s.username)}" stroke="${s.color}" points="${points}"/>`;
  });
  svg += `<line class="chart-cursor" id="chartCursor" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>`;
  svg += '</svg>';
  statsGraphContainer.innerHTML = svg;

  const cursor = $('chartCursor');
  statsGraphContainer.onmousemove = (e) => {
    const rect = statsGraphContainer.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (days - 1));
    if (idx < 0 || idx >= days || !ref.length) { hideChartTooltip(); return; }
    cursor.setAttribute('x1', x(idx));
    cursor.setAttribute('x2', x(idx));
    cursor.setAttribute('visibility', 'visible');

    const rows = stats
      .map((s) => ({ s, day: s.last30[idx - (days - s.last30.length)] }))
      .filter((r) => r.day)
      .sort((a, b) => b.day.count - a.day.count);
    const date = rows.length ? rows[0].day.date : ref[idx].date;
    graphTooltip.innerHTML = `<div class="gt-date">${escapeHtml(formatDate(date))}</div>` + rows
      .map((r) => `<div class="gt-row"><i style="background:${r.s.color}"></i>${escapeHtml(r.s.username)}<b>${r.day.count}</b></div>`)
      .join('');
    const panelRect = $('statsPanel').getBoundingClientRect();
    graphTooltip.classList.add('visible');
    let left = e.clientX - panelRect.left + 14;
    if (left + graphTooltip.offsetWidth > panelRect.width - 6) left = e.clientX - panelRect.left - graphTooltip.offsetWidth - 14;
    const top = Math.max(4, Math.min(e.clientY - panelRect.top - graphTooltip.offsetHeight / 2, panelRect.height - graphTooltip.offsetHeight - 4));
    graphTooltip.style.left = `${left}px`;
    graphTooltip.style.top = `${top}px`;
  };
  statsGraphContainer.onmouseleave = hideChartTooltip;
  function hideChartTooltip() {
    cursor.setAttribute('visibility', 'hidden');
    graphTooltip.classList.remove('visible');
  }
}

function renderInsights() {
  const s = state.stats;
  const tiles = $('insightTiles');
  if (!s) {
    tiles.innerHTML = '<div class="no-data" style="grid-column: span 4">No data yet.</div>';
    $('weekdayBars').innerHTML = '';
    return;
  }
  const pctActive = s.totalDays ? Math.round((s.activeDays / s.totalDays) * 100) : 0;
  const m = S.formatMomentum(s.momentum);
  const tile = (label, value, sub) => `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div><div class="tile-sub">${sub}</div></div>`;
  tiles.innerHTML = [
    tile('Total (last year)', formatNumber(s.total), `${s.avgPerDay.toFixed(1)} per day`),
    tile('Active days', `${s.activeDays}`, `${pctActive}% of ${s.totalDays} days`),
    tile('Current streak', `🔥 ${s.currentStreak}`, s.currentStreak ? 'days in a row' : 'start one today!'),
    tile('Longest streak', `🏆 ${s.longestStreak}`, 'days'),
    tile('Best day', s.maxDay ? formatNumber(s.maxDay.count) : '0', s.maxDay ? escapeHtml(formatDate(s.maxDay.date)) : '—'),
    tile('Best weekday', S.WEEKDAY_NAMES[s.bestWeekday].slice(0, 3), `${s.weekdayAvg[s.bestWeekday].toFixed(1)} avg`),
    tile('Last 7 days', formatNumber(s.last7), `<span class="tone-${m.tone}">${escapeHtml(m.text)}</span>`),
    tile('Today', formatNumber(s.today), state.config && state.config.daily_goal && !isVersus ? `goal ${state.config.daily_goal}` : 'contributions'),
  ].join('');

  const maxAvg = Math.max(...s.weekdayAvg, 0.0001);
  $('weekdayBars').innerHTML = s.weekdayAvg.map((avg, i) => `
    <div class="weekday-bar ${i === s.bestWeekday ? 'best' : ''}" title="${S.WEEKDAY_NAMES[i]}: ${avg.toFixed(2)} avg">
      <span style="height:${Math.max(2, (avg / maxAvg) * 100)}%"></span>${S.WEEKDAY_NAMES[i][0]}
    </div>`).join('');
}

// ── PNG export ──────────────────────────────────────────────────
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function renderPng() {
  const weeks = state.data.weeks.slice(-53);
  const colors = (THEMES[state.theme] || THEMES.green).colors;
  const s = state.stats;
  const cell = 11;
  const step = 14;
  const padX = 24;
  const gridX = padX + 30;
  const gridY = 74;
  const width = gridX + weeks.length * step + padX;
  const height = gridY + 7 * step + 58;
  const scale = 2;

  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  const font = (size, weight = 400) => `${weight} ${size}px "Segoe UI", -apple-system, sans-serif`;

  ctx.fillStyle = '#0d1117';
  roundRect(ctx, 0, 0, width, height, 14);
  ctx.fill();
  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 1;
  roundRect(ctx, 0.5, 0.5, width - 1, height - 1, 14);
  ctx.stroke();

  ctx.fillStyle = '#e6edf3';
  ctx.font = font(16, 600);
  ctx.fillText(`${state.displayUser}'s contributions`, padX, 32);
  ctx.fillStyle = '#8b949e';
  ctx.font = font(12);
  ctx.fillText(`${formatNumber(s.total)} in the last year  ·  🔥 ${s.currentStreak}-day streak  ·  🏆 ${s.longestStreak} longest`, padX, 52);

  ctx.font = font(9, 500);
  let col = 0;
  S.monthLabels(weeks).forEach((m) => {
    if (m.span >= 2) ctx.fillText(m.name, gridX + col * step, gridY - 6);
    col += m.span;
  });
  ['Mon', 'Wed', 'Fri'].forEach((label, i) => {
    ctx.textAlign = 'right';
    ctx.fillText(label, gridX - 6, gridY + (1 + i * 2) * step + 9);
    ctx.textAlign = 'left';
  });

  weeks.forEach((week, w) => {
    const offset = w === 0 ? S.parseISODate(week[0].date).getDay() : 0;
    week.forEach((day, d) => {
      ctx.fillStyle = colors[Math.max(0, Math.min(4, day.level | 0))];
      roundRect(ctx, gridX + w * step, gridY + (d + offset) * step, cell, cell, 2);
      ctx.fill();
    });
  });

  const footY = gridY + 7 * step + 24;
  ctx.fillStyle = '#8b949e';
  ctx.font = font(10);
  ctx.fillText(`github.com/${state.displayUser}`, padX, footY + 9);
  ctx.textAlign = 'right';
  const legendX = width - padX - 5 * step - 30;
  ctx.fillText('Less', legendX - 6, footY + 9);
  colors.forEach((c, i) => {
    ctx.fillStyle = c;
    roundRect(ctx, legendX + i * step, footY, cell, cell, 2);
    ctx.fill();
  });
  ctx.fillStyle = '#8b949e';
  ctx.textAlign = 'left';
  ctx.fillText('More', legendX + 5 * step + 4, footY + 9);
  return canvas;
}

async function exportPng() {
  if (!state.data || !state.stats) {
    showToast('Nothing to export yet', 'error');
    return;
  }
  try {
    const canvas = renderPng();
    const dataUrl = canvas.toDataURL('image/png');
    const name = `contributions-${state.displayUser}-${todayISO()}.png`;
    const path = await api.savePng(name, dataUrl.split(',')[1]);
    let copied = false;
    try {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      copied = true;
    } catch (_) { /* clipboard is best-effort */ }
    showToast(`${copied ? 'Copied to clipboard & saved' : 'Saved'} to ${path}`, 'success');
  } catch (err) {
    showToast(`Export failed: ${errText(err)}`, 'error');
  }
}

// ── Buttons & keyboard ──────────────────────────────────────────
btnRefresh.addEventListener('click', () => loadData(true));
$('btnSettings').addEventListener('click', openSettings);
$('btnVs').addEventListener('click', openVersusPanel);
$('btnStats').addEventListener('click', openStats);
$('btnExport').addEventListener('click', exportPng);
$('btnClose').addEventListener('click', () => api.minimizeToTray());
$('btnProfile').addEventListener('click', () => {
  const user = state.displayUser;
  if (user) api.openExternal(`https://github.com/${encodeURIComponent(user)}`).catch((err) => showToast(errText(err), 'error'));
  else openSettings();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const id = openPanelId();
    if (id) closePanel(id);
    return;
  }
  const typing = e.target.closest && e.target.closest('input, select, textarea');
  if (typing || openPanelId() || e.ctrlKey || e.altKey || e.metaKey) return;
  const key = e.key.toLowerCase();
  if (key === 'r') loadData(true);
  else if (key === 's') openSettings();
  else if (key === 'v') openVersusPanel();
  else if (key === 'l') openStats();
  else if (key === 'e') exportPng();
});

// ── Backend events ──────────────────────────────────────────────
function onConfigChanged(cfg) {
  const previous = state.config;
  state.config = cfg;
  if (!state.draft) applyConfig(cfg);
  if (!isVersus && previous && !sameUser(previous.username, cfg.username)) {
    state.displayUser = cfg.username || null;
    renderTitle();
  }
  if ($('vsPanel').classList.contains('visible')) renderVsHistory();
  renderStatsStrip();
  updateStatus();
}

listen('config-changed', (e) => onConfigChanged(e.payload));

listen('data-updated', (e) => {
  const { username, data } = e.payload;
  if (sameUser(username, state.displayUser)) showData(data);
  else if (isVersus && state.config && sameUser(username, state.config.username)) {
    state.mainStats = S.computeStats(data.weeks, todayISO());
    renderStatsStrip();
  }
});

listen('refresh-state', (e) => setBusy(Boolean(e.payload)));

listen('opacity-preview', (e) => applyOpacity(e.payload));

listen('click-through-changed', (e) => widget.classList.toggle('click-through', Boolean(e.payload)));

if (!isVersus) listen('open-settings', () => openSettings());

// ── Init ────────────────────────────────────────────────────────
async function init() {
  state.config = await api.getConfig();
  applyConfig(state.config);

  if (isVersus) {
    state.displayUser = versusUser;
    ['btnVs', 'btnSettings'].forEach((id) => { $(id).style.display = 'none'; });
    $('btnClose').title = 'Close versus window';
  } else {
    state.displayUser = state.config.username || null;
  }
  renderTitle();
  renderQuotes();

  if (!state.displayUser) {
    showNoData();
    scheduleFit();
    return;
  }

  const cached = await api.getData(state.displayUser).catch(() => null);
  if (cached) showData(cached);
  scheduleFit();
  if (isVersus) loadMainStatsForVersus();

  // Serve cache instantly, then refresh only if it's stale.
  await loadData(false);
}

init().catch((err) => {
  console.error(err);
  state.error = errText(err);
  updateStatus();
});
