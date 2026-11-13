// Weblate: any instance, self-hosted or not. Contributors are looked up by
// username, so nothing has to be listed by hand; see ../core.js for how.

import { WeblateClient } from '../api.js';
import { refreshInstance } from '../core.js';
import { PLATFORM_META } from '../presets.js';
import { underscored } from './shared.js';

const languageRow = (l) => ({
  code: l.code,
  name: l.name || l.code,
  total: l.total,
  translated: l.translated,
  percent: l.translated_percent,
  lastChange: l.last_change ? new Date(l.last_change).toISOString() : null,
  recent: l.recent_changes ?? 0,
  url: l.url,
});

export const weblate = {
  id: 'weblate',
  ...PLATFORM_META.weblate,
  tokenRequired: false,
  tokenHint: 'Your profile → API access',
  browser: true, // depends on the instance; Hosted Weblate allows it
  languageCode: underscored,

  createClient: (opts) => new WeblateClient(opts),

  refresh: (client, instance, opts) =>
    refreshInstance(client, instance, { ...opts, language: instance.language || opts.language }),

  /** Coverage of one project in every language (maintainer view). */
  async projectLanguages(client, project) {
    const slug = encodeURIComponent(project);
    const info = await client.get(`projects/${slug}/`);
    const rows = await client.get(`projects/${slug}/languages/`);
    return {
      project: { slug: info.slug, name: info.name, url: info.web_url, web: info.web || '' },
      languages: rows.map(languageRow),
    };
  },

  /**
   * Walk the instance's project list, a few projects per call, reading each
   * project's coverage in `language`. `cursor` is what the previous call
   * returned; `budget` caps the requests spent.
   */
  async catalog(client, { language, cursor, budget = 15 }) {
    const pageSize = 100;
    let { page = 1, index = 0 } = cursor || {};
    const projects = [];
    let total = null;
    let complete = false;
    let spent = 0;
    while (spent < budget) {
      const list = await client.get('projects/', { page, page_size: pageSize });
      spent += 1;
      total = list.count ?? total;
      const rows = list.results || [];
      while (index < rows.length && spent < budget) {
        const p = rows[index];
        const langs = await client.get(`projects/${encodeURIComponent(p.slug)}/languages/`);
        spent += 1;
        index += 1;
        const mine = langs.find((l) => String(l.code).toLowerCase() === language.toLowerCase());
        const size = Math.max(0, ...langs.map((l) => l.total || 0));
        if (!size) continue;
        projects.push({
          slug: p.slug,
          name: p.name,
          url: mine?.url || p.web_url,
          web: p.web || '',
          total: mine?.total ?? size,
          translated: mine?.translated ?? 0,
          percent: mine?.translated_percent ?? 0,
          started: !!mine,
          languages: langs.length,
          stars: null,
          lastChange: mine?.last_change || null,
        });
      }
      if (index < rows.length) break;
      if (!list.next) {
        complete = true;
        page = 1;
        index = 0;
        break;
      }
      page += 1;
      index = 0;
    }
    return { projects, cursor: { page, index }, complete, total };
  },
};
