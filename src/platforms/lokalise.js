// Lokalise. Needs an API token of someone who is a contributor of the project
// (open-source projects on Lokalise hand out access on request). Projects are
// listed by project id, shown under Project settings → General.
// The API sends no CORS headers, so browsers rely on the Action's snapshot.

import { PLATFORM_META } from '../presets.js';
import { HttpClient } from '../api.js';
import { makeEntry, projectSlug, refreshProjects, sameCode, underscored } from './shared.js';

const APP = 'https://app.lokalise.com';

export const lokalise = {
  id: 'lokalise',
  ...PLATFORM_META.lokalise,
  tokenRequired: true,
  tokenHint: 'Profile settings → API tokens (a read-only token is enough)',
  browser: false,
  languageCode: underscored,

  createClient: (opts) =>
    new HttpClient({ ...opts, apiRoot: '/api2', auth: (t) => ({ 'X-Api-Token': t }) }),

  refresh(client, instance, opts) {
    const code = this.languageCode(instance.language || opts.language);
    const now = opts.now ?? Date.now();
    return refreshProjects(
      client,
      instance,
      { ...opts, now, tokenRequired: true, platformName: instance.name },
      async (ref) => {
        const project = await client.get(`projects/${encodeURIComponent(ref)}`);
        const stats = project.statistics || {};
        const mine = (stats.languages || []).find((l) => sameCode(l.language_iso, code));
        if (!mine) throw new Error(`it has no "${code}" translation`);
        const total = stats.keys_total || 0;
        const url = `${APP}/project/${project.project_id}/?view=multi`;
        return [
          makeEntry({
            instance,
            platform: 'lokalise',
            project: { slug: projectSlug(ref), name: project.name, url },
            component: { slug: '', name: project.name },
            language: { code: mine.language_iso, name: '' },
            total,
            translated: Math.round((total * mine.progress) / 100),
            webUrl: url,
            nextUrl: `${url}&filter=untranslated`,
            now,
          }),
        ];
      },
    );
  },

  async projectLanguages(client, ref) {
    const project = await client.get(`projects/${encodeURIComponent(ref)}`);
    const stats = project.statistics || {};
    const total = stats.keys_total || 0;
    const url = `${APP}/project/${project.project_id}/`;
    return {
      project: { slug: project.project_id, name: project.name, url },
      languages: (stats.languages || [])
        .filter((l) => !sameCode(l.language_iso, project.base_language_iso))
        .map((l) => ({
          code: l.language_iso,
          name: l.language_iso,
          total,
          translated: Math.round((total * l.progress) / 100),
          percent: l.progress,
          lastChange: null,
          url,
        })),
    };
  },
};
