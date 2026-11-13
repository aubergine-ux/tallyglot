// Pontoon (Mozilla). Public REST API, no token. Pontoon is organised by locale
// team rather than by contributor, so one request returns every project the
// locale takes part in; `projects` in the config narrows that down.
// The API sends no CORS headers, so browsers rely on the Action's snapshot.

import { PLATFORM_META } from '../presets.js';
import { HttpClient, NotFoundError } from '../api.js';
import { emptyResult, hyphenated, makeEntry, sameCode } from './shared.js';

export const pontoon = {
  id: 'pontoon',
  ...PLATFORM_META.pontoon,
  tokenRequired: false,
  tokenHint: '',
  browser: false,
  languageCode: hyphenated,

  createClient: (opts) => new HttpClient({ ...opts, apiRoot: '/api/v2' }),

  async refresh(client, instance, opts) {
    const { previous = [], now = Date.now(), language } = opts;
    const out = emptyResult(previous, opts.known || {});
    const code = this.languageCode(instance.language || language);
    let locale;
    try {
      locale = await client.get(`locales/${encodeURIComponent(code)}/`);
    } catch (err) {
      if (err.name === 'RateLimitError') {
        out.limited = true;
        out.retryAfter = err.retryAfter;
      } else if (err.name === 'NetworkError') {
        out.unreachable = true;
        out.errors.push(err.message);
      } else if (err instanceof NotFoundError) {
        out.errors.push(`${instance.name} has no "${code}" locale.`);
      } else {
        out.errors.push(err.message);
      }
      return out;
    }
    const wanted = instance.pinned.filter((p) => p !== '*');
    const available = locale.localizations || [];
    for (const slug of wanted) {
      if (!available.some((l) => l.project?.slug === slug)) {
        out.errors.push(`Project "${slug}" is not enabled for ${code} on ${instance.name}.`);
      }
    }
    out.entries = available
      .filter((l) => !wanted.length || wanted.includes(l.project.slug))
      .map((l) => localizationEntry(l, { instance, locale, now }));
    out.fetched = out.entries.length;
    return out;
  },

  /** Coverage of one project in every locale (maintainer view). */
  async projectLanguages(client, project) {
    const data = await client.get(`projects/${encodeURIComponent(project)}/`);
    return {
      project: {
        slug: data.slug,
        name: data.name,
        url: `${client.baseUrl}/projects/${data.slug}/`,
      },
      languages: (data.localizations || []).map((l) => ({
        code: l.locale.code,
        name: l.locale.name,
        total: l.total_strings,
        translated: l.completed_strings,
        percent: l.total_strings
          ? Math.floor((l.completed_strings / l.total_strings) * 1000) / 10
          : 0,
        lastChange: null,
        url: `${client.baseUrl}/${l.locale.code}/${data.slug}/`,
      })),
    };
  },

  /** Every public project with this locale's coverage (two requests). */
  async catalog(client, { language }) {
    const code = this.languageCode(language);
    const [locale, list] = await Promise.all([
      client.get(`locales/${encodeURIComponent(code)}/`).catch((err) => {
        if (err instanceof NotFoundError) return { localizations: [] };
        throw err;
      }),
      client.get('projects/', { page_size: 200 }),
    ]);
    const mine = new Map((locale.localizations || []).map((l) => [l.project.slug, l]));
    const projects = (list.results || [])
      .filter((p) => !p.disabled && !p.system_project && p.visibility === 'public')
      .map((p) => {
        const l = mine.get(p.slug);
        const enabled = (p.locales || []).some((c) => sameCode(c, code));
        const total = l?.total_strings ?? 0;
        return {
          slug: p.slug,
          name: p.name,
          url: `${client.baseUrl}/${enabled ? `${code}/` : 'projects/'}${p.slug}/`,
          total,
          translated: l?.completed_strings ?? 0,
          percent: total ? Math.floor((l.completed_strings / total) * 1000) / 10 : 0,
          started: !!l,
          languages: (p.locales || []).length,
          stars: null,
          priority: p.priority ?? null,
        };
      });
    return { projects, cursor: null, complete: true, total: projects.length };
  },
};

function localizationEntry(l, { instance, locale, now }) {
  const base = `${instance.url}/${locale.code}/${l.project.slug}/`;
  return makeEntry({
    instance,
    platform: 'pontoon',
    project: { slug: l.project.slug, name: l.project.name, url: base },
    component: { slug: '', name: l.project.name },
    language: { code: locale.code, name: locale.name },
    total: l.total_strings,
    translated: l.completed_strings,
    approved: l.approved_strings,
    failing: (l.strings_with_errors || 0) + (l.strings_with_warnings || 0),
    suggestions: l.unreviewed_strings || 0,
    webUrl: base,
    translateUrl: `${base}all-resources/`,
    nextUrl: l.missing_strings
      ? `${base}all-resources/?status=missing`
      : l.unreviewed_strings
        ? `${base}all-resources/?status=unreviewed`
        : base,
    now,
  });
}
