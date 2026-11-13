import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reviewSeason } from '../src/ui.js';
import { SHARE_SIZES, shareImage, wrappedStats, yearsWithData } from '../src/wrapped.js';

const activity = {
  days: {
    '2025-12-30': { 'h:a': 4 },
    '2025-12-31': { 'h:a': 6 },
    '2026-01-01': { 'h:a': 5, 'h:b': 1 },
    '2026-01-02': { 'h:b': 2 },
    '2026-03-10': { 'h:c': 40 },
    '2026-03-11': { 'h:c': 10 },
    '2026-03-12': { 'h:a': 3 },
    '2026-12-31': { 'h:a': 1 },
    '2027-01-01': { 'h:a': 9 },
  },
};
const points = [
  { day: '2025-12-31', o: [1000, 400], p: { 'h:a': [100, 99] } },
  { day: '2026-01-05', o: [1000, 500], p: { 'h:a': [100, 99], 'h:b': [50, 10] } },
  { day: '2026-06-01', o: [1100, 800], p: { 'h:a': [100, 100], 'h:b': [50, 50] } },
  { day: '2026-12-30', o: [1100, 990], p: { 'h:a': [120, 100], 'h:b': [50, 50] } },
];

test('wrapped: one year only, across its boundaries', () => {
  const s = wrappedStats({
    activity,
    points,
    names: { 'h:a': 'Alpha', 'h:c': 'Gamma' },
    year: 2026,
  });
  assert.equal(s.contributions, 62);
  assert.equal(s.activeDays, 6);
  // the streak that began in December 2025 counts only from 1 January
  assert.deepEqual([s.longestStreak, s.streakStart, s.streakEnd], [3, '2026-03-10', '2026-03-12']);
  assert.deepEqual([s.busiestMonth, s.busiestMonthCount], ['2026-03', 53]);
  assert.deepEqual([s.busiestDay, s.busiestDayCount], ['2026-03-10', 40]);
  assert.deepEqual(s.months, [8, 0, 53, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(s.projects, 3);
  assert.deepEqual(s.topProjects, [
    { key: 'h:c', name: 'Gamma', changes: 50 },
    { key: 'h:a', name: 'Alpha', changes: 9 },
    { key: 'h:b', name: 'b', changes: 3 },
  ]);
  assert.deepEqual(s.completed, ['Alpha', 'b']);
  assert.deepEqual([s.percentStart, s.percentEnd, s.stringsGained], [50, 90, 490]);
  assert.equal(s.empty, false);
});

test('wrapped: years without data, and data without activity', () => {
  assert.deepEqual(yearsWithData(activity, points), [2027, 2026, 2025]);
  assert.deepEqual(yearsWithData(null, []), []);
  const none = wrappedStats({ activity, points, year: 2019 });
  assert.equal(none.empty, true);
  assert.deepEqual(
    [
      none.contributions,
      none.longestStreak,
      none.busiestMonth,
      none.busiestDay,
      none.percentStart,
      none.stringsGained,
    ],
    [0, 0, null, null, null, null],
  );
  assert.deepEqual(none.months, Array(12).fill(0));
  const historyOnly = wrappedStats({ activity: null, points, year: 2026 });
  assert.equal(historyOnly.empty, false);
  assert.equal(historyOnly.contributions, 0);
  assert.equal(historyOnly.completed.length, 2);
  // a leap year's 29 February belongs to the streak
  const leap = wrappedStats({
    activity: { days: { '2028-02-28': { x: 1 }, '2028-02-29': { x: 1 }, '2028-03-01': { x: 1 } } },
    year: 2028,
  });
  assert.equal(leap.longestStreak, 3);
});

test('wrapped: the review is announced in December and January only', () => {
  assert.equal(reviewSeason(new Date('2026-12-01T00:00:00Z')), 2026);
  assert.equal(reviewSeason(new Date('2026-12-31T23:59:59Z')), 2026);
  assert.equal(reviewSeason(new Date('2027-01-15T00:00:00Z')), 2026);
  assert.equal(reviewSeason(new Date('2027-02-01T00:00:00Z')), null);
  assert.equal(reviewSeason(new Date('2026-11-30T23:59:59Z')), null);
});

test('wrapped: share image in both sizes and themes, escaped, without NaN', () => {
  const stats = wrappedStats({ activity, points, names: { 'h:c': 'Gam<ma> & "co"' }, year: 2026 });
  const labels = {
    title: 'Albanian <2026>',
    contributions: 'contributions',
    activeDays: 'active days',
    streak: 'streak',
    busiest: 'busiest month',
    top: 'Top projects',
    footer: 'alice & co',
  };
  for (const size of Object.keys(SHARE_SIZES)) {
    for (const theme of ['light', 'dark']) {
      const svg = shareImage(stats, { size, theme, labels, monthName: 'March' });
      const [w, h] = SHARE_SIZES[size];
      assert.ok(
        svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"`),
      );
      assert.ok(!/NaN|undefined|Infinity/.test(svg), `${size}/${theme}`);
      assert.ok(svg.includes('Albanian &#60;2026&#62;'));
      assert.ok(svg.includes('alice &#38; co'));
      assert.ok(svg.includes('>62<') && svg.includes('>March<'));
      assert.equal(svg.match(/<rect /g).length, 2 + 4 + 12); // background, logo, tiles, months
    }
  }
  assert.ok(
    shareImage(stats, { size: 'square', labels, monthName: '' }).includes(
      'Gam&#60;ma&#62; &#38; &#34;co&#34;',
    ),
  );
  assert.deepEqual(SHARE_SIZES, { wide: [1200, 630], square: [1080, 1080] });
  // an empty year still draws
  const empty = shareImage(wrappedStats({ activity: null, year: 2020 }), { labels, monthName: '' });
  assert.ok(!/NaN/.test(empty) && empty.includes('>–<'));
  assert.equal(
    shareImage(stats, { size: 'huge', theme: 'neon', labels }).slice(0, 80),
    shareImage(stats, { labels }).slice(0, 80),
  );
});
