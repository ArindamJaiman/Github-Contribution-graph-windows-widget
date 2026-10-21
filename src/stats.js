/**
 * stats.js — pure helpers for contribution statistics and formatting.
 * Loaded as a plain <script> in the widget (exposes window.WidgetStats)
 * and as a CommonJS module by the Node test suite.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WidgetStats = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const pad2 = (n) => String(n).padStart(2, '0');

  /** Local calendar date as YYYY-MM-DD (never UTC — avoids off-by-one days). */
  function toISODate(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  /** Parses YYYY-MM-DD as a *local* date. `new Date('2024-03-01')` would be UTC. */
  function parseISODate(str) {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(iso, n) {
    const d = parseISODate(iso);
    d.setDate(d.getDate() + n);
    return toISODate(d);
  }

  /** Monday of the week containing `iso` (race weeks run Monday–Sunday). */
  function weekStart(iso) {
    return addDays(iso, -((parseISODate(iso).getDay() + 6) % 7));
  }

  /**
   * Weekly race numbers: this and last week's totals, and this week's seven
   * days Monday→Sunday (null where the calendar has no entry yet).
   */
  function weekStats(days, todayISO) {
    const start = weekStart(todayISO);
    const end = addDays(start, 6);
    const prevStart = addDays(start, -7);
    const byDate = new Map(days.map((d) => [d.date, d]));
    let thisWeek = 0;
    let lastWeek = 0;
    for (const d of days) {
      if (d.date >= start && d.date <= end) thisWeek += d.count;
      else if (d.date >= prevStart && d.date < start) lastWeek += d.count;
    }
    return {
      weekStart: start,
      thisWeek,
      lastWeek,
      weekDays: Array.from({ length: 7 }, (_, i) => byDate.get(addDays(start, i)) || null),
    };
  }

  function flatten(weeks) {
    const days = [];
    for (const week of weeks || []) {
      for (const day of week || []) {
        if (day && day.date) days.push(day);
      }
    }
    days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return days;
  }

  function sum(days) {
    let total = 0;
    for (const d of days) total += d.count;
    return total;
  }

  function momentum(last7, prev7) {
    const diff = last7 - prev7;
    if (prev7 === 0) {
      return { diff, pct: null, direction: last7 > 0 ? 'up' : 'flat' };
    }
    const pct = Math.round((diff / prev7) * 100);
    return { diff, pct, direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat' };
  }

  function formatMomentum(m) {
    if (m.direction === 'flat') return { text: '➖ 0%', tone: 'flat' };
    if (m.pct === null) return { text: `📈 new (+${m.diff})`, tone: 'up' };
    const sign = m.diff > 0 ? '+' : '';
    return {
      text: `${m.diff > 0 ? '📈' : '📉'} ${sign}${m.pct}% (${sign}${m.diff})`,
      tone: m.direction,
    };
  }

  /**
   * Computes every statistic the widget shows. The last calendar day is treated
   * as "today": a zero there doesn't break the current streak.
   */
  function computeStats(weeks, todayISO) {
    const days = flatten(weeks);
    const weekdayTotals = [0, 0, 0, 0, 0, 0, 0];
    const weekdayDays = [0, 0, 0, 0, 0, 0, 0];
    let total = 0;
    let activeDays = 0;
    let maxDay = null;
    let longestStreak = 0;
    let run = 0;

    for (const d of days) {
      total += d.count;
      if (!maxDay || d.count > maxDay.count) maxDay = { date: d.date, count: d.count };
      if (d.count > 0) {
        activeDays++;
        run++;
        if (run > longestStreak) longestStreak = run;
      } else {
        run = 0;
      }
      const weekday = parseISODate(d.date).getDay();
      weekdayTotals[weekday] += d.count;
      weekdayDays[weekday]++;
    }

    let currentStreak = 0;
    for (let i = days.length - 1; i >= 0; i--) {
      if (days[i].count > 0) currentStreak++;
      else if (i === days.length - 1) continue;
      else break;
    }

    const last = days[days.length - 1];
    const today = last && todayISO && last.date >= todayISO
      ? (days.find((d) => d.date === todayISO) || { count: 0 }).count
      : 0;

    const last7 = sum(days.slice(-7));
    const prev7 = sum(days.slice(-14, -7));
    const weekdayAvg = weekdayTotals.map((t, i) => (weekdayDays[i] ? t / weekdayDays[i] : 0));
    let bestWeekday = 0;
    weekdayAvg.forEach((avg, i) => { if (avg > weekdayAvg[bestWeekday]) bestWeekday = i; });

    return {
      total,
      activeDays,
      totalDays: days.length,
      maxDay,
      longestStreak,
      currentStreak,
      today,
      last7,
      prev7,
      momentum: momentum(last7, prev7),
      last30: days.slice(-30),
      weekdayAvg,
      bestWeekday,
      avgPerDay: days.length ? total / days.length : 0,
      ...weekStats(days, todayISO || (last ? last.date : toISODate(new Date()))),
    };
  }

  /** Month labels for the graph header: [{ name, span }] where span is in weeks. */
  function monthLabels(weeks) {
    const labels = [];
    let lastMonth = -1;
    (weeks || []).forEach((week, i) => {
      if (!week || week.length === 0) return;
      // Label a month at the first week that contains its 1st..7th day, like GitHub.
      const first = week.find((d) => parseISODate(d.date).getDate() <= 7) || week[0];
      const month = parseISODate(first.date).getMonth();
      if (month !== lastMonth) {
        labels.push({ name: MONTH_NAMES[month], start: i });
        lastMonth = month;
      }
    });
    return labels.map((l, i) => ({
      name: l.name,
      span: (i + 1 < labels.length ? labels[i + 1].start : weeks.length) - l.start,
    }));
  }

  function formatNumber(n) {
    return Math.round(n).toLocaleString('en-US');
  }

  function relativeTime(iso, now) {
    if (!iso) return 'never';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return 'unknown';
    const secs = Math.max(0, Math.round(((now || Date.now()) - then) / 1000));
    if (secs < 45) return 'just now';
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /** Normalises a user-typed key combo into the backend's shortcut syntax. */
  function shortcutFromEvent(e) {
    const mods = [];
    if (e.ctrlKey) mods.push('ctrl');
    if (e.altKey) mods.push('alt');
    if (e.shiftKey) mods.push('shift');
    if (e.metaKey) mods.push('super');
    let key = null;
    let m;
    if ((m = /^Key([A-Z])$/.exec(e.code))) key = m[1].toLowerCase();
    else if ((m = /^Digit(\d)$/.exec(e.code))) key = m[1];
    else if ((m = /^F(\d{1,2})$/.exec(e.code))) key = `f${m[1]}`;
    else if (e.code === 'Space') key = 'space';
    if (!key) return null;
    // Bare letters/digits would swallow normal typing system-wide.
    if (mods.length === 0 && !/^f\d+$/.test(key)) return null;
    return [...mods, key].join('+');
  }

  function prettyShortcut(spec) {
    if (!spec) return '';
    return spec.split('+').map((part) => {
      if (part === 'ctrl') return 'Ctrl';
      if (part === 'alt') return 'Alt';
      if (part === 'shift') return 'Shift';
      if (part === 'super') return 'Win';
      if (part === 'space') return 'Space';
      return part.toUpperCase();
    }).join(' + ');
  }

  return {
    MONTH_NAMES,
    WEEKDAY_NAMES,
    toISODate,
    parseISODate,
    addDays,
    weekStart,
    flatten,
    computeStats,
    formatMomentum,
    monthLabels,
    formatNumber,
    relativeTime,
    escapeHtml,
    shortcutFromEvent,
    prettyShortcut,
  };
});
