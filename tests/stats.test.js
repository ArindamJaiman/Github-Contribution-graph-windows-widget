'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/stats.js');

const day = (date, count) => ({ date, count, level: count === 0 ? 0 : Math.min(4, Math.ceil(count / 3)) });

test('parseISODate / toISODate use local dates (no UTC off-by-one)', () => {
  const d = S.parseISODate('2024-03-01');
  assert.equal(d.getMonth(), 2);
  assert.equal(d.getDate(), 1);
  assert.equal(S.toISODate(d), '2024-03-01');
});

test('current streak tolerates an empty today but not an empty yesterday', () => {
  const weeks = [[day('2024-10-06', 0), day('2024-10-07', 2), day('2024-10-08', 1), day('2024-10-09', 4), day('2024-10-10', 0)]];
  const s = S.computeStats(weeks, '2024-10-10');
  assert.equal(s.currentStreak, 3);
  assert.equal(s.longestStreak, 3);
  assert.equal(s.today, 0);
  assert.equal(s.total, 7);
  assert.equal(s.activeDays, 3);

  const broken = [[day('2024-10-08', 1), day('2024-10-09', 0), day('2024-10-10', 0)]];
  assert.equal(S.computeStats(broken, '2024-10-10').currentStreak, 0);
});

test('today is 0 when the calendar has not reached the local date yet', () => {
  const weeks = [[day('2024-10-09', 5)]];
  assert.equal(S.computeStats(weeks, '2024-10-10').today, 0);
  assert.equal(S.computeStats(weeks, '2024-10-09').today, 5);
});

test('best day, weekday averages and momentum', () => {
  const days = [];
  for (let i = 1; i <= 14; i++) days.push(day(`2024-09-${String(i).padStart(2, '0')}`, i <= 7 ? 1 : 3));
  const s = S.computeStats([days], '2024-09-14');
  assert.deepEqual(s.maxDay, { date: '2024-09-08', count: 3 });
  assert.equal(s.last7, 21);
  assert.equal(s.prev7, 7);
  assert.deepEqual(s.momentum, { diff: 14, pct: 200, direction: 'up' });
  assert.equal(S.formatMomentum(s.momentum).text, '📈 +200% (+14)');
  assert.equal(s.weekdayAvg.length, 7);
  assert.equal(s.last30.length, 14);
});

test('momentum from zero is reported as new instead of a fake +100%', () => {
  const m = S.formatMomentum({ diff: 5, pct: null, direction: 'up' });
  assert.equal(m.text, '📈 new (+5)');
  assert.equal(S.formatMomentum({ diff: 0, pct: null, direction: 'flat' }).text, '➖ 0%');
  assert.equal(S.formatMomentum({ diff: -3, pct: -50, direction: 'down' }).tone, 'down');
});

test('month labels span the right number of weeks', () => {
  const weeks = [
    [day('2024-09-22', 0)],
    [day('2024-09-29', 0), day('2024-09-30', 0), day('2024-10-01', 0)], // holds Oct 1 → labelled Oct
    [day('2024-10-06', 0)], [day('2024-10-13', 0)],
  ];
  assert.deepEqual(S.monthLabels(weeks), [
    { name: 'Sep', span: 1 },
    { name: 'Oct', span: 3 },
  ]);
});

test('relative time formatting', () => {
  const now = Date.parse('2024-10-10T12:00:00Z');
  assert.equal(S.relativeTime('2024-10-10T11:59:40Z', now), 'just now');
  assert.equal(S.relativeTime('2024-10-10T11:55:00Z', now), '5m ago');
  assert.equal(S.relativeTime('2024-10-10T09:00:00Z', now), '3h ago');
  assert.equal(S.relativeTime('2024-10-08T12:00:00Z', now), '2d ago');
  assert.equal(S.relativeTime(null, now), 'never');
});

test('escapeHtml neutralises markup', () => {
  assert.equal(S.escapeHtml('<img src=x onerror="1">'), '&lt;img src=x onerror=&quot;1&quot;&gt;');
});

test('shortcut capture requires a modifier and normalises keys', () => {
  assert.equal(S.shortcutFromEvent({ ctrlKey: true, altKey: true, code: 'KeyF' }), 'ctrl+alt+f');
  assert.equal(S.shortcutFromEvent({ shiftKey: true, metaKey: true, code: 'Digit3' }), 'shift+super+3');
  assert.equal(S.shortcutFromEvent({ code: 'F9' }), 'f9');
  assert.equal(S.shortcutFromEvent({ code: 'KeyA' }), null);
  assert.equal(S.shortcutFromEvent({ ctrlKey: true, code: 'ControlLeft' }), null);
  assert.equal(S.prettyShortcut('ctrl+alt+f'), 'Ctrl + Alt + F');
});
