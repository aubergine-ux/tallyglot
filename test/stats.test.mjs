import assert from 'node:assert/strict';
import { test } from 'node:test';

import { heatmap, lineChart, niceRange } from '../src/charts.js';
import {
  calendar,
  dailyCounts,
  dropInstance,
  emptyActivity,
  historyDays,
  historyPoint,
  leaderboard,
  milestones,
  monthlyCounts,
  recordChanges,
  series,
  streaks,
} from '../src/stats.js';
import { fixture } from './helpers.mjs';

const change = (project, timestamp) => ({
  translation: `https://w.test/api/translations/${project}/main/sq/`,
  timestamp,
  action_name: 'Translation added',
});

test('activity: changes are counted per UTC day, project and user', () => {
  const a = emptyActivity();
  recordChanges(a, 'hosted', 'alice', [
    change('alpha', '2026-03-01T23:30:00+02:00'), // 21:30 UTC, still 1 March
    change('alpha', '2026-03-02T01:30:00+02:00'), // 23:30 UTC on 1 March
    change('beta', '2026-03-02T12:00:00Z'),
    { translation: null, timestamp: '2026-03-02T12:00:00Z' }, // not a translation change
  ]);
  recordChanges(a, 'hosted', 'bob', [change('alpha', '2026-03-05T08:00:00Z')]);
  assert.deepEqual(a.days, {
    '2026-03-01': { 'hosted:alpha': 2 },
    '2026-03-02': { 'hosted:beta': 1 },
    '2026-03-05': { 'hosted:alpha': 1 },
  });
  assert.deepEqual(dailyCounts(a), { '2026-03-01': 2, '2026-03-02': 1, '2026-03-05': 1 });
  assert.deepEqual(dailyCounts(a, 'hosted:alpha'), { '2026-03-01': 2, '2026-03-05': 1 });
  assert.deepEqual(
    leaderboard(a).map((r) => [r.name, r.changes, r.days]),
    [
      ['alice', 3, 2],
      ['bob', 1, 1],
    ],
  );
  assert.deepEqual(
    leaderboard(a, { since: '2026-03-03' }).map((r) => r.name),
    ['bob'],
  );
  assert.equal(a.recent[0].user, 'bob');
  assert.deepEqual(monthlyCounts(dailyCounts(a)), { '2026-03': 4 });
});

test('activity: a recorded Weblate change is understood', () => {
  const a = emptyActivity();
  recordChanges(a, 'hosted', 'me', fixture('weblate-changes').results);
  assert.deepEqual(Object.values(a.days)[0], { 'hosted:trale': 2 });
  assert.equal(a.recent[0].component, 'localizations');
});

test('activity: an instance can be forgotten without touching the others', () => {
  const a = emptyActivity();
  recordChanges(a, 'hosted', 'alice', [change('alpha', '2026-03-01T10:00:00Z')]);
  recordChanges(a, 'codeberg', 'alice', [change('alpha', '2026-03-01T10:00:00Z')]);
  a.sources = { hosted: 'x', codeberg: 'y' };
  dropInstance(a, 'hosted');
  assert.deepEqual(a.days, { '2026-03-01': { 'codeberg:alpha': 1 } });
  assert.deepEqual(Object.keys(a.users), ['codeberg']);
  assert.deepEqual(a.sources, { codeberg: 'y' });
  assert.equal(a.recent.length, 1);
});

test('activity: only the newest changes are kept in "recent"', () => {
  const a = emptyActivity();
  const many = Array.from({ length: 200 }, (_, i) =>
    change('alpha', new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()),
  );
  recordChanges(a, 'hosted', 'alice', many);
  assert.equal(a.recent.length, 60);
  assert.equal(a.recent[0].at, '2026-01-01T03:19:00.000Z');
});

test('streaks: current, longest, and the grace of an unfinished today', () => {
  const counts = {
    '2026-01-01': 1,
    '2026-01-02': 4,
    '2026-01-03': 1,
    '2026-01-10': 2,
    '2026-01-11': 2,
  };
  assert.deepEqual(streaks(counts, '2026-01-11'), {
    current: 2,
    longest: 3,
    longestStart: '2026-01-01',
    longestEnd: '2026-01-03',
    activeDays: 5,
  });
  assert.equal(streaks(counts, '2026-01-12').current, 2); // nothing yet today
  assert.equal(streaks(counts, '2026-01-13').current, 0);
  assert.deepEqual(streaks({}, '2026-01-13'), {
    current: 0,
    longest: 0,
    longestStart: null,
    longestEnd: null,
    activeDays: 0,
  });
  // across a month and a leap day
  assert.equal(
    streaks({ '2028-02-28': 1, '2028-02-29': 1, '2028-03-01': 1 }, '2028-03-01').current,
    3,
  );
});

test('calendar: weeks start on Monday and end on the last day', () => {
  const cal = calendar(
    { '2026-11-12': 8, '2026-11-09': 1, '2025-01-01': 9 },
    { end: '2026-11-12', weeks: 3 },
  );
  assert.equal(cal.columns.length, 3);
  assert.equal(cal.start, '2026-10-26'); // a Monday
  assert.equal(cal.columns[2][0].day, '2026-11-09');
  assert.deepEqual(cal.columns[2][3], { day: '2026-11-12', count: 8, level: 4 });
  assert.equal(cal.columns[2][0].level, 1); // one change is still visible
  assert.equal(cal.columns[2][4], null); // days after the end
  assert.equal(cal.total, 9); // outside the range is not counted
  assert.equal(calendar({}, { end: '2026-11-12', weeks: 2 }).max, 0);
});

const entry = (project, total, translated) => ({
  instance: 'hosted',
  project: { slug: project, name: project },
  total,
  translated,
  fuzzy: 0,
  untranslated: total - translated,
});

test('history: points, merged years and series', () => {
  const pt = historyPoint([entry('a', 100, 50), entry('a', 100, 100), entry('b', 10, 10)]);
  assert.deepEqual(pt, {
    o: [210, 160, 0, 3, 2],
    p: { 'hosted:a': [200, 150], 'hosted:b': [10, 10] },
  });
  const points = historyDays([
    { days: { '2026-01-01': { o: [100, 60], p: { 'hosted:a': [100, 60] } } } },
    { days: { '2025-12-31': { o: [100, 50], p: {} } } },
    null,
  ]);
  assert.deepEqual(
    points.map((p) => p.day),
    ['2025-12-31', '2026-01-01'],
  );
  assert.deepEqual(series(points), [
    { day: '2025-12-31', percent: 50, translated: 50, total: 100 },
    { day: '2026-01-01', percent: 60, translated: 60, total: 100 },
  ]);
  assert.deepEqual(
    series(points, 'hosted:a').map((p) => p.day),
    ['2026-01-01'],
  );
});

test('milestones: completions, month summary, round numbers and streaks', () => {
  const points = [
    { day: '2026-10-30', p: { a: [10, 5], b: [10, 9], c: [10, 10] } },
    { day: '2026-11-02', p: { a: [10, 10], b: [10, 9], c: [10, 10] } },
    { day: '2026-11-05', p: { a: [10, 10], b: [12, 12], c: [10, 10], d: [5, 5] } },
  ];
  const activity = { days: {} };
  for (let i = 1; i <= 8; i += 1) activity.days[`2026-11-0${i}`] = { a: 20 };
  const list = milestones(points, activity, { today: '2026-11-08', names: { a: 'Alpha' } });
  const kinds = list.map((m) => `${m.kind}:${m.day}:${m.name || m.count}`);
  assert.deepEqual(kinds, [
    'streak:2026-11-07:7',
    'changes:2026-11-05:100',
    'complete:2026-11-05:b',
    'monthComplete:2026-11-05:2',
    'complete:2026-11-02:Alpha',
  ]);
  // c was already complete and d appeared complete: neither is "reached 100%"
  assert.deepEqual(milestones([], null), []);
});

test('charts: axis range and svg output', () => {
  assert.deepEqual(niceRange(96.2, 96.9), { lo: 96, hi: 97, ticks: [96, 96.5, 97] });
  assert.deepEqual(niceRange(40, 90).ticks, [40, 60, 80, 100]);
  assert.deepEqual(niceRange(100, 100), { lo: 99, hi: 100, ticks: [99, 99.5, 100] });
  const one = lineChart([{ day: '2026-01-01', percent: 50 }]);
  assert.equal(one.coords.length, 1);
  assert.ok(!one.svg.includes('NaN'));
  const two = lineChart([
    { day: '2026-01-01', percent: 50 },
    { day: '2026-01-03', percent: 75.5 },
  ]);
  assert.match(two.svg, /<path d="M40 [\d.]+L674 [\d.]+"/);
  assert.match(two.svg, />75\.5%<\/text>/);
  const svg = heatmap(calendar({ '2026-11-12': 3 }, { end: '2026-11-12', weeks: 2 }), {
    describe: (c) => `<${c.day}>`,
  });
  assert.equal(svg.match(/<rect /g).length, 11); // one full week + Mon–Thu
  assert.ok(svg.includes('&#60;2026-11-12&#62;'));
});
