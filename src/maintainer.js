// Maintainer view: one project's coverage in every language, who has been
// translating it lately, and which languages have gone quiet.

import { renderBadge, percentColor, formatPercent } from './badge.js';
import { barChart } from './charts.js';
import { TRANSLATION_ACTIONS } from './core.js';

const DAY = 86400000;

/** File name stem for a project's generated files. */
export const maintainerKey = (instanceId, project) =>
  `${instanceId}--${project}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');

/** People behind a list of Weblate changes, most active first. Bots are left out. */
export function translatorsFromChanges(changes) {
  const people = new Map();
  for (const change of changes) {
    const name = /\/api\/users\/([^/]+)\/?$/.exec(change.user || '')?.[1];
    const language = /\/api\/translations\/.+\/([^/]+)\/?$/.exec(change.translation || '')?.[1];
    if (!name || !language || name.includes(':') || /^(anonymous|deleted-)/.test(name)) continue;
    const who = decodeURIComponent(name);
    const row = people.get(who) || { name: who, changes: 0, last: '', languages: new Set() };
    row.changes += 1;
    row.languages.add(language);
    const stamp = change.timestamp ? new Date(change.timestamp).toISOString() : '';
    if (stamp > row.last) row.last = stamp;
    people.set(who, row);
  }
  return [...people.values()]
    .map((p) => ({ ...p, languages: [...p.languages].sort() }))
    .sort((a, b) => b.changes - a.changes || b.last.localeCompare(a.last));
}

/**
 * Everything the page shows, fetched through the platform's adapter.
 * `translators` is null where the platform does not tell.
 */
export async function loadProject(adapter, client, project) {
  if (!adapter.projectLanguages) throw new Error(`${adapter.name} has no project statistics`);
  const view = await adapter.projectLanguages(client, project);
  let translators = null;
  if (adapter.id === 'weblate') {
    try {
      const { results } = await client.getPaged(
        `projects/${encodeURIComponent(project)}/changes/`,
        { action: TRANSLATION_ACTIONS, page_size: 300 },
        1,
      );
      translators = translatorsFromChanges(results);
    } catch {
      translators = null; // coverage alone is still worth showing
    }
  }
  return { ...view, translators };
}

/** Numbers for the tiles, and the languages sorted and marked. */
export function summarizeLanguages(languages, { staleDays = 90, now = Date.now() } = {}) {
  const rows = languages
    .filter((l) => l.total > 0)
    .map((l) => {
      const complete = l.translated >= l.total;
      const quietDays = l.lastChange ? Math.floor((now - Date.parse(l.lastChange)) / DAY) : null;
      return {
        ...l,
        name: l.name || l.code,
        complete,
        quietDays,
        stale: !complete && quietDays !== null && quietDays >= staleDays,
      };
    })
    .sort((a, b) => b.percent - a.percent || a.name.localeCompare(b.name));
  const average = rows.length
    ? Math.floor((rows.reduce((n, l) => n + l.percent, 0) / rows.length) * 10) / 10
    : 0;
  return {
    rows,
    count: rows.length,
    average,
    complete: rows.filter((l) => l.complete).length,
    stale: rows.filter((l) => l.stale).length,
    // Activity dates are only known on some platforms.
    datesKnown: rows.some((l) => l.quietDays !== null),
  };
}

const CHART_COLORS = {
  light: {
    background: '#ffffff',
    text: '#5d564c',
    ink: '#1d1a16',
    line: '#e8590c',
    levels: ['#ece7dd'],
  },
  dark: {
    background: '#1d1b18',
    text: '#b5ad9f',
    ink: '#f2eee7',
    line: '#ea6218',
    levels: ['#2d2a25'],
  },
};

/** Coverage chart for a README: the best-covered languages, as SVG. */
export function coverageChart(view, theme = 'light', { max = 15 } = {}) {
  const { rows, count, average } = summarizeLanguages(view.languages);
  const shown = rows.slice(0, max).map((l) => ({ label: l.name, percent: l.percent }));
  if (rows.length > max) {
    const rest = rows.slice(max);
    const mean = Math.floor((rest.reduce((n, l) => n + l.percent, 0) / rest.length) * 10) / 10;
    shown.push({ label: `${rest.length} more (average)`, percent: mean });
  }
  return barChart(shown, {
    colors: CHART_COLORS[theme] || CHART_COLORS.light,
    title: `${view.project.name}: ${count} language${count === 1 ? '' : 's'}, ${average}% on average`,
  });
}

/** "translated | 28 languages · 64%" */
export function coverageBadge(view) {
  const { count, average } = summarizeLanguages(view.languages);
  return renderBadge({
    label: 'translated',
    message: count
      ? `${count} language${count === 1 ? '' : 's'} · ${formatPercent(average)}`
      : 'no languages yet',
    color: count ? percentColor(average) : '#777',
  });
}

/** README snippet: chart that follows the reader's colour scheme, linked to the page. */
export function maintainerSnippet(site, key, pageUrl, name) {
  return (
    `<a href="${pageUrl}">\n  <picture>\n` +
    `    <source media="(prefers-color-scheme: dark)" srcset="${site}maintainer/${key}-dark.svg">\n` +
    `    <img src="${site}maintainer/${key}.svg" alt="${name.replace(/"/g, '&quot;')} translation coverage by language">\n` +
    `  </picture>\n</a>`
  );
}
