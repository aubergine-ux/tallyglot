// Profile card: an SVG summary for a README, in the spirit of
// github-readme-stats. Rendered by the Action into cards/<theme>.svg and by
// the Stats page as a live preview.

import { achievements, earnedMarks } from './achievements.js';
import { aggregate, groupByProject, isComplete } from './core.js';
import { dailyCounts, streaks, totalChanges } from './stats.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n) => new Intl.NumberFormat('en').format(n);

// Each family has a light and a dark variant; README snippets pair them in a
// <picture> element so the card follows the reader's colour scheme.
export const CARD_THEMES = {
  light: {
    bg: '#ffffff',
    border: '#e3ddd2',
    title: '#b8400a',
    text: '#1d1a16',
    muted: '#5d564c',
    accent: '#e8590c',
    track: '#ece7dd',
  },
  dark: {
    bg: '#1d1b18',
    border: '#322e28',
    title: '#ff9d6b',
    text: '#f2eee7',
    muted: '#b5ad9f',
    accent: '#ea6218',
    track: '#2d2a25',
  },
  'aubergine-light': {
    bg: '#fbf7fd',
    border: '#e4d6ee',
    title: '#6b2a8c',
    text: '#241a2b',
    muted: '#62536d',
    accent: '#8b3fb5',
    track: '#eadff1',
  },
  'aubergine-dark': {
    bg: '#1c1522',
    border: '#35283f',
    title: '#d6a4f2',
    text: '#f1e9f6',
    muted: '#b3a3bf',
    accent: '#a65fd0',
    track: '#30243a',
  },
  'ocean-light': {
    bg: '#f6fbfd',
    border: '#cfe3ec',
    title: '#0b5f80',
    text: '#10242c',
    muted: '#4a626c',
    accent: '#0e7fa8',
    track: '#dcebf1',
  },
  'ocean-dark': {
    bg: '#0f1b21',
    border: '#1f3440',
    title: '#7fd0ee',
    text: '#e6f3f8',
    muted: '#9bb6c2',
    accent: '#1f9bc9',
    track: '#1c303a',
  },
  'mono-light': {
    bg: '#ffffff',
    border: '#d9d9d9',
    title: '#111111',
    text: '#111111',
    muted: '#555555',
    accent: '#111111',
    track: '#e6e6e6',
  },
  'mono-dark': {
    bg: '#0d0d0d',
    border: '#333333',
    title: '#f5f5f5',
    text: '#f5f5f5',
    muted: '#a6a6a6',
    accent: '#f5f5f5',
    track: '#2b2b2b',
  },
};

export const CARD_FAMILIES = ['default', 'aubergine', 'ocean', 'mono'];
export const cardFiles = (family) =>
  family === 'default'
    ? { light: 'light.svg', dark: 'dark.svg' }
    : { light: `${family}-light.svg`, dark: `${family}-dark.svg` };

/** Everything the card shows, from the data the dashboard already has. */
export function cardData({ entries, activity, title, languageNames = {}, today }) {
  const stats = aggregate(entries);
  const counts = dailyCounts(activity);
  const byLanguage = new Map();
  for (const e of entries) {
    const code = e.language?.code || '';
    const row = byLanguage.get(code) || { code, name: '', total: 0, translated: 0 };
    row.name ||= e.language?.name || languageNames[code] || code;
    row.total += e.total;
    row.translated += e.translated;
    byLanguage.set(code, row);
  }
  return {
    title,
    percent: stats.percent,
    translated: stats.translated,
    projects: stats.projects,
    completeProjects: groupByProject(entries).filter((g) => g.entries.every(isComplete)).length,
    contributions: totalChanges(counts),
    streak: streaks(counts, today).current,
    languages: [...byLanguage.values()]
      .sort((a, b) => b.translated - a.translated)
      .slice(0, 3)
      .map((l) => ({
        name: l.name,
        translated: l.translated,
        percent: l.total ? Math.floor((l.translated / l.total) * 1000) / 10 : 0,
      })),
    marks: earnedMarks(achievements({ entries, activity, today })).map((a) => a.mark),
  };
}

export function renderCard(data, theme = 'light') {
  const c = CARD_THEMES[theme] || CARD_THEMES.light;
  const width = 480;
  const rows = [
    ['Strings translated', fmt(data.translated)],
    ['Projects', `${fmt(data.projects)} (${fmt(data.completeProjects)} complete)`],
    ['Contributions', fmt(data.contributions)],
    ['Current streak', `${fmt(data.streak)} day${data.streak === 1 ? '' : 's'}`],
  ];
  const rowsTop = 62;
  const rowH = 24;
  const langTop = rowsTop + rows.length * rowH + 14;
  const langH = 22;
  const marksTop = langTop + 20 + data.languages.length * langH + (data.languages.length ? 6 : 0);
  const height = marksTop + (data.marks.length ? 44 : 6);
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const cx = width - 78;
  const cy = rowsTop + 40;
  const share = Math.max(0, Math.min(100, data.percent)) / 100;
  const label = `${data.title}: ${data.percent}% translated, ${fmt(data.translated)} strings in ${data.projects} projects, ${data.streak} day streak`;

  const statRows = rows
    .map(
      ([name, value], i) =>
        `<text x="24" y="${rowsTop + i * rowH}" fill="${c.muted}">${name}</text>` +
        `<text x="200" y="${rowsTop + i * rowH}" fill="${c.text}" font-weight="600">${esc(value)}</text>`,
    )
    .join('');
  const languages = data.languages
    .map((l, i) => {
      const y = langTop + 20 + i * langH;
      const barW = 190;
      return (
        `<text x="24" y="${y + 4}" fill="${c.text}">${esc(l.name)}</text>` +
        `<rect x="200" y="${y - 5}" width="${barW}" height="8" rx="4" fill="${c.track}"/>` +
        `<rect x="200" y="${y - 5}" width="${Math.round(barW * Math.min(100, l.percent)) / 100}" height="8" rx="4" fill="${c.accent}"/>` +
        `<text x="${width - 24}" y="${y + 4}" text-anchor="end" fill="${c.muted}">${l.percent}%</text>`
      );
    })
    .join('');
  const marks = data.marks
    .map(
      (mark, i) =>
        `<g transform="translate(${24 + i * 42} ${marksTop})">` +
        `<circle cx="15" cy="15" r="15" fill="none" stroke="${c.accent}" stroke-width="1.5"/>` +
        `<text x="15" y="19" text-anchor="middle" font-size="${mark.length > 3 ? 9 : 11}" font-weight="700" fill="${c.text}">${esc(mark)}</text></g>`,
    )
    .join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">` +
    `<title>${esc(label)}</title>` +
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="${c.bg}" stroke="${c.border}"/>` +
    `<g font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" font-size="13">` +
    `<text x="24" y="34" font-size="17" font-weight="700" fill="${c.title}">${esc(data.title)}</text>` +
    statRows +
    `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${c.track}" stroke-width="7"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${c.accent}" stroke-width="7" stroke-linecap="round" ` +
    `stroke-dasharray="${(circumference * share).toFixed(1)} ${circumference.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>` +
    `<text x="${cx}" y="${cy + 6}" text-anchor="middle" font-size="17" font-weight="700" fill="${c.text}">${data.percent}%</text>` +
    (data.languages.length
      ? `<text x="24" y="${langTop}" font-size="11" font-weight="700" fill="${c.muted}" letter-spacing=".06em">TOP LANGUAGES</text>${languages}`
      : '') +
    marks +
    `</g></svg>\n`
  );
}

/** HTML for a README: the dark card for dark mode readers, the light one otherwise. */
export function cardSnippet(site, family, alt) {
  const files = cardFiles(family);
  return (
    `<a href="${site}">\n` +
    `  <picture>\n` +
    `    <source media="(prefers-color-scheme: dark)" srcset="${site}cards/${files.dark}">\n` +
    `    <img src="${site}cards/${files.light}" alt="${alt.replace(/"/g, '&quot;')}">\n` +
    `  </picture>\n` +
    `</a>`
  );
}
