// Translator portfolio: a public summary of someone's translation work, and
// the same facts as JSON Resume entries.

import { achievements } from './achievements.js';
import { groupByProject, isComplete } from './core.js';
import { repoOf } from './findwork.js';
import { PLATFORM_META } from './presets.js';
import { dailyCounts, totalChanges } from './stats.js';

/** Avatar of the project's owner on its forge, or '' when the homepage is elsewhere. */
export function projectLogo(web) {
  const r = repoOf(web);
  if (!r || r.host === 'gitlab.com') return ''; // GitLab has no avatar address by name
  return `https://${r.host}/${encodeURIComponent(r.owner)}.png?size=96`;
}

/**
 * @returns {{name: string, languages: object[], projects: object[], totals: object,
 *            since: string|null, earned: object[]}}
 */
export function portfolioData({ entries, activity, config, languageName, today }) {
  const counts = dailyCounts(activity);
  const days = Object.keys(counts).sort();
  const perProject = {};
  for (const [day, bucket] of Object.entries(activity?.days || {})) {
    for (const [key, n] of Object.entries(bucket)) {
      const p = (perProject[key] ||= { changes: 0, first: day, last: day });
      p.changes += n;
      if (day < p.first) p.first = day;
      if (day > p.last) p.last = day;
    }
  }
  const projects = groupByProject(entries)
    .map((g) => {
      const first = g.entries[0];
      const mine = perProject[g.key] || { changes: 0, first: null, last: null };
      return {
        key: g.key,
        name: g.project.name,
        url: g.project.url,
        web: g.project.web || '',
        logo: projectLogo(g.project.web),
        platform: PLATFORM_META[first.platform || 'weblate'].name,
        language: first.language?.name || languageName,
        languageCode: first.language?.code || config.language,
        percent: g.stats.percent,
        translated: g.stats.translated,
        total: g.stats.total,
        complete: g.entries.every(isComplete),
        contributions: mine.changes,
        since: mine.first,
        until: mine.last,
      };
    })
    .sort(
      (a, b) =>
        b.contributions - a.contributions ||
        b.translated - a.translated ||
        a.name.localeCompare(b.name),
    );

  const byLanguage = new Map();
  for (const p of projects) {
    const row = byLanguage.get(p.languageCode) || {
      code: p.languageCode,
      name: p.language,
      projects: 0,
      translated: 0,
    };
    row.projects += 1;
    row.translated += p.translated;
    byLanguage.set(p.languageCode, row);
  }
  return {
    name: config.displayName || config.team.name || config.usernames[0] || '',
    team: !!config.team.name && !config.displayName,
    languages: [...byLanguage.values()].sort((a, b) => b.translated - a.translated),
    projects,
    totals: {
      translated: projects.reduce((n, p) => n + p.translated, 0),
      projects: projects.length,
      complete: projects.filter((p) => p.complete).length,
      contributions: totalChanges(counts),
      platforms: new Set(projects.map((p) => p.platform)).size,
    },
    since: days[0] || null,
    earned: achievements({ entries, activity, today }).filter((a) => a.earned),
  };
}

const fmt = (n) => new Intl.NumberFormat('en').format(n);

/**
 * JSON Resume (jsonresume.org, schema 1.0.0): translation work as "volunteer"
 * entries, ready to be merged into an existing resume.json.
 */
export function toJsonResume(data, { site = '' } = {}) {
  return {
    $schema: 'https://raw.githubusercontent.com/jsonresume/resume-schema/v1.0.0/schema.json',
    basics: {
      name: data.name,
      label: 'Translator',
      ...(site ? { url: site } : {}),
      summary:
        `Open-source translator: ${fmt(data.totals.translated)} strings across ` +
        `${data.totals.projects} project${data.totals.projects === 1 ? '' : 's'}` +
        (data.languages.length ? ` (${data.languages.map((l) => l.name).join(', ')}).` : '.'),
    },
    volunteer: data.projects.map((p) => ({
      organization: p.name,
      position: `${p.language} translator`,
      url: p.web || p.url,
      ...(p.since ? { startDate: p.since } : {}),
      ...(p.until ? { endDate: p.until } : {}),
      summary: `Translated ${p.name} into ${p.language} on ${p.platform}.`,
      highlights: [
        `${fmt(p.translated)} of ${fmt(p.total)} strings translated (${p.percent}%)`,
        ...(p.contributions ? [`${fmt(p.contributions)} contributions`] : []),
        ...(p.complete ? ['Brought the translation to 100%'] : []),
      ],
    })),
    languages: data.languages.map((l) => ({ language: l.name })),
  };
}
