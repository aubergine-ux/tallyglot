// Year in review: one year's activity boiled down to a handful of numbers,
// and a share image drawn from them.

import { dailyCounts, monthlyCounts, series, streaks } from './stats.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n) => new Intl.NumberFormat('en').format(n);

/** Years that have any recorded activity or history, newest first. */
export function yearsWithData(activity, points) {
  const years = new Set();
  for (const day of Object.keys(activity?.days || {})) years.add(Number(day.slice(0, 4)));
  for (const p of points || []) years.add(Number(p.day.slice(0, 4)));
  return [...years].sort((a, b) => b - a);
}

/**
 * @param {object} o
 * @param {object} o.activity   data/activity.json
 * @param {object[]} o.points   history days (stats.historyDays)
 * @param {object} o.names      "instance:project" -> display name
 * @param {number} o.year
 */
export function wrappedStats({ activity, points = [], names = {}, year }) {
  const prefix = `${year}-`;
  const inYear = (day) => day.startsWith(prefix);
  const counts = Object.fromEntries(
    Object.entries(dailyCounts(activity)).filter(([day]) => inYear(day)),
  );
  const days = Object.keys(counts).sort();
  const total = days.reduce((n, d) => n + counts[d], 0);

  const months = monthlyCounts(counts);
  const [busiestMonth, busiestMonthCount] = Object.entries(months).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0] || [null, 0];
  const [busiestDay, busiestDayCount] = Object.entries(counts).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0] || [null, 0];

  // The streak is measured inside the year: 31 December is its last possible day.
  const streak = streaks(counts, `${year}-12-31`);

  const perProject = {};
  for (const [day, bucket] of Object.entries(activity?.days || {})) {
    if (!inYear(day)) continue;
    for (const [key, n] of Object.entries(bucket)) perProject[key] = (perProject[key] || 0) + n;
  }
  const topProjects = Object.entries(perProject)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([key, changes]) => ({
      key,
      name: names[key] || key.split(':').slice(1).join(':'),
      changes,
    }));

  const yearPoints = points.filter((p) => inYear(p.day));
  const done = (pair) => pair && pair[0] > 0 && pair[1] >= pair[0];
  const completed = new Set();
  for (let i = 1; i < yearPoints.length; i += 1) {
    for (const [key, pair] of Object.entries(yearPoints[i].p || {})) {
      const before = yearPoints[i - 1].p?.[key];
      if (done(pair) && before && !done(before)) completed.add(key);
    }
  }
  const overall = series(yearPoints);
  const first = overall[0];
  const last = overall[overall.length - 1];

  return {
    year,
    empty: total === 0 && yearPoints.length === 0,
    contributions: total,
    activeDays: days.length,
    longestStreak: streak.longest,
    streakStart: streak.longestStart,
    streakEnd: streak.longestEnd,
    busiestMonth, // "2026-03" or null
    busiestMonthCount,
    busiestDay,
    busiestDayCount,
    months: Array.from(
      { length: 12 },
      (_, i) => months[`${prefix}${String(i + 1).padStart(2, '0')}`] || 0,
    ),
    projects: Object.keys(perProject).length,
    topProjects,
    completed: [...completed].map((key) => names[key] || key.split(':').slice(1).join(':')).sort(),
    percentStart: first ? first.percent : null,
    percentEnd: last ? last.percent : null,
    stringsGained: first && last ? last.translated - first.translated : null,
  };
}

export const SHARE_SIZES = {
  wide: [1200, 630], // link previews on most networks
  square: [1080, 1080],
};

const SHARE_THEMES = {
  light: {
    bg: '#f5f2ec',
    card: '#ffffff',
    ink: '#1d1a16',
    muted: '#5d564c',
    accent: '#e8590c',
    track: '#ece7dd',
  },
  dark: {
    bg: '#131210',
    card: '#1d1b18',
    ink: '#f2eee7',
    muted: '#b5ad9f',
    accent: '#ea6218',
    track: '#2d2a25',
  },
};

/**
 * The share image, as SVG. `labels` carries the words, so the page can pass
 * translated ones: { title, contributions, activeDays, streak, busiest, top, footer }.
 */
export function shareImage(stats, { size = 'wide', theme = 'light', labels, monthName = '' }) {
  const [width, height] = SHARE_SIZES[size] || SHARE_SIZES.wide;
  const c = SHARE_THEMES[theme] || SHARE_THEMES.light;
  const square = size === 'square';
  const pad = 64;
  const tiles = [
    [fmt(stats.contributions), labels.contributions],
    [fmt(stats.activeDays), labels.activeDays],
    [fmt(stats.longestStreak), labels.streak],
    [monthName || '–', labels.busiest],
  ];
  const cols = square ? 2 : 4;
  const gap = 20;
  const tileW = (width - pad * 2 - gap * (cols - 1)) / cols;
  const tileH = square ? 170 : 150;
  const tilesTop = square ? 250 : 210;
  const tileSvg = tiles
    .map(([value, label], i) => {
      const x = pad + (i % cols) * (tileW + gap);
      const y = tilesTop + Math.floor(i / cols) * (tileH + gap);
      const long = String(value).length > 9;
      return (
        `<rect x="${x}" y="${y}" width="${tileW}" height="${tileH}" rx="18" fill="${c.card}"/>` +
        `<text x="${x + 24}" y="${y + (square ? 86 : 76)}" font-size="${long ? 38 : 54}" font-weight="800" fill="${c.ink}">${esc(value)}</text>` +
        `<text x="${x + 24}" y="${y + tileH - 28}" font-size="22" fill="${c.muted}">${esc(label)}</text>`
      );
    })
    .join('');

  const rows = Math.ceil(tiles.length / cols);
  const barsTop = tilesTop + rows * (tileH + gap) + (square ? 60 : 36);
  const max = Math.max(1, ...stats.months);
  const barAreaH = square ? 150 : 70;
  const barW = (width - pad * 2 - 11 * 10) / 12;
  const bars = stats.months
    .map((n, i) => {
      const h = n ? Math.max(6, (n / max) * barAreaH) : 3;
      const x = pad + i * (barW + 10);
      return `<rect x="${x.toFixed(1)}" y="${(barsTop + barAreaH - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="5" fill="${n ? c.accent : c.track}"/>`;
    })
    .join('');
  const top =
    square && stats.topProjects.length
      ? `<text x="${pad}" y="${barsTop + barAreaH + 70}" font-size="24" fill="${c.muted}">${esc(labels.top)}</text>` +
        `<text x="${pad}" y="${barsTop + barAreaH + 112}" font-size="32" font-weight="700" fill="${c.ink}">${esc(
          stats.topProjects
            .slice(0, 3)
            .map((p) => p.name)
            .join(' · ')
            .slice(0, 54),
        )}</text>`
      : '';

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="${c.bg}"/>` +
    `<g font-family="system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans',sans-serif">` +
    // the tally mark logo
    `<g transform="translate(${pad} ${pad - 8}) scale(1.75)"><rect width="32" height="32" rx="8" fill="${c.accent}"/>` +
    `<g stroke="#fff" stroke-width="2.6" stroke-linecap="round"><path d="M8 9v14M13 9v14M18 9v14M23 9v14"/><path d="M5.5 20.5 26.5 11.5"/></g></g>` +
    `<text x="${pad + 74}" y="${pad + 32}" font-size="30" font-weight="700" fill="${c.muted}">Tallyglot</text>` +
    `<text x="${pad}" y="${square ? 190 : 162}" font-size="${square ? 60 : 54}" font-weight="800" fill="${c.ink}">${esc(labels.title)}</text>` +
    tileSvg +
    bars +
    top +
    `<text x="${pad}" y="${height - 40}" font-size="20" fill="${c.muted}">${esc(labels.footer)}</text>` +
    `</g></svg>`
  );
}
