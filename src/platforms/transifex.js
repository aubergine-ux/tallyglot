// Transifex. API v3 (JSON:API) needs a token. Projects are "organization/project",
// exactly as in the address https://app.transifex.com/<organization>/<project>/.

import { PLATFORM_META } from '../presets.js';
import { HttpClient } from '../api.js';
import { makeEntry, percent, projectSlug, refreshProjects, underscored } from './shared.js';

const APP = 'https://app.transifex.com';

async function listAll(client, path, params) {
  const rows = [];
  let next = client.url(path, params);
  for (let page = 0; next && page < 20; page += 1) {
    const body = await client.get(next);
    rows.push(...(body.data || []));
    next = body.links?.next || null;
  }
  return rows;
}

function split(ref) {
  const [org, project] = String(ref).split('/');
  if (!org || !project) throw new Error('write it as "organization/project"');
  return { org, project, id: `o:${org}:p:${project}` };
}

export const transifex = {
  id: 'transifex',
  ...PLATFORM_META.transifex,
  tokenRequired: true,
  tokenHint: 'User settings → API token',
  browser: true,
  languageCode: underscored,

  createClient: (opts) =>
    new HttpClient({
      ...opts,
      accept: 'application/vnd.api+json',
      auth: (t) => ({ Authorization: `Bearer ${t}` }),
    }),

  refresh(client, instance, opts) {
    const code = this.languageCode(instance.language || opts.language);
    const now = opts.now ?? Date.now();
    return refreshProjects(
      client,
      instance,
      { ...opts, now, tokenRequired: true, platformName: instance.name },
      async (ref) => {
        const { org, project, id } = split(ref);
        const [info, resources, stats] = [
          await client.get(`projects/${id}`),
          await listAll(client, 'resources', { 'filter[project]': id }),
          await listAll(client, 'resource_language_stats', {
            'filter[project]': id,
            'filter[language]': `l:${code}`,
          }),
        ];
        if (!stats.length) throw new Error(`it has no "${code}" translation`);
        const names = new Map(resources.map((r) => [r.id, r.attributes]));
        const projectName = info.data?.attributes?.name || project;
        const projectUrl = `${APP}/${org}/${project}/language/${code}/`;
        return stats.map((row) => {
          const a = row.attributes;
          const resourceId = row.relationships?.resource?.data?.id || '';
          const slug = names.get(resourceId)?.slug || resourceId.split(':r:')[1] || resourceId;
          const editor = `${APP}/${org}/${project}/translate/#${code}/${slug}`;
          return makeEntry({
            instance,
            platform: 'transifex',
            project: { slug: projectSlug(ref), name: projectName, url: projectUrl },
            component: { slug, name: names.get(resourceId)?.name || slug },
            language: { code, name: '' },
            total: a.total_strings,
            translated: a.translated_strings,
            approved: a.reviewed_strings > 0 ? a.reviewed_strings : null,
            lastChange: a.last_translation_update || a.last_update,
            webUrl: projectUrl,
            translateUrl: editor,
            nextUrl: a.untranslated_strings ? `${editor}?q=translated%3Ano` : editor,
            now,
          });
        });
      },
    );
  },

  async projectLanguages(client, ref) {
    const { org, project, id } = split(ref);
    const info = await client.get(`projects/${id}`);
    const stats = await listAll(client, 'resource_language_stats', { 'filter[project]': id });
    const byLang = new Map();
    for (const row of stats) {
      const code = (row.relationships?.language?.data?.id || '').replace(/^l:/, '');
      const a = row.attributes;
      const l = byLang.get(code) || { code, name: code, total: 0, translated: 0, lastChange: null };
      l.total += a.total_strings;
      l.translated += a.translated_strings;
      const stamp = a.last_translation_update;
      if (stamp && (!l.lastChange || stamp > l.lastChange)) l.lastChange = stamp;
      byLang.set(code, l);
    }
    return {
      project: {
        slug: project,
        name: info.data?.attributes?.name || project,
        url: `${APP}/${org}/${project}/`,
      },
      languages: [...byLang.values()].map((l) => ({
        ...l,
        percent: percent(l.translated, l.total),
        url: `${APP}/${org}/${project}/language/${l.code}/`,
      })),
    };
  },
};
