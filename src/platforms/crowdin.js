// Crowdin (crowdin.com). API v2 needs a personal access token even for public
// projects. Projects are listed in the config by numeric id or by identifier
// (the last part of the project's address); identifiers are resolved through
// the list of projects the token's owner has joined.

import { PLATFORM_META } from '../presets.js';
import { HttpClient, NotFoundError } from '../api.js';
import { hyphenated, makeEntry, projectSlug, refreshProjects, sameCode } from './shared.js';

const PAGE = 500;

async function listAll(client, path, params = {}) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await client.get(path, { ...params, limit: PAGE, offset });
    const data = (page.data || []).map((d) => d.data);
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

async function resolveProject(client, ref, cache) {
  if (/^\d+$/.test(ref)) return (await client.get(`projects/${ref}`)).data;
  cache.list ||= await listAll(client, 'projects');
  const found = cache.list.find((p) => String(p.identifier).toLowerCase() === ref.toLowerCase());
  if (!found) throw new NotFoundError(`Not found: ${ref}`);
  return found;
}

const projectUrl = (p, code) =>
  p.webUrl ? `${p.webUrl}/${code}` : `https://crowdin.com/project/${p.identifier}/${code}`;

export const crowdin = {
  id: 'crowdin',
  ...PLATFORM_META.crowdin,
  tokenRequired: true,
  tokenHint: 'Account settings → API → Personal access tokens',
  browser: true,
  languageCode: hyphenated,

  createClient: (opts) =>
    new HttpClient({
      ...opts,
      apiRoot: '/api/v2',
      auth: (t) => ({ Authorization: `Bearer ${t}` }),
    }),

  refresh(client, instance, opts) {
    const code = this.languageCode(instance.language || opts.language);
    const now = opts.now ?? Date.now();
    const cache = {};
    return refreshProjects(
      client,
      instance,
      { ...opts, now, tokenRequired: true, platformName: instance.name },
      async (ref) => {
        const project = await resolveProject(client, ref, cache);
        const progress = await listAll(client, `projects/${project.id}/languages/progress`);
        const mine = progress.find((p) => sameCode(p.languageId, code));
        if (!mine) throw new Error(`it has no "${code}" translation`);
        const url = projectUrl(project, mine.languageId);
        return [
          makeEntry({
            instance,
            platform: 'crowdin',
            project: { slug: projectSlug(ref), name: project.name, url },
            component: { slug: '', name: project.name },
            language: { code: mine.languageId, name: mine.language?.name || '' },
            total: mine.phrases.total,
            translated: mine.phrases.translated,
            approved: mine.phrases.approved > 0 ? mine.phrases.approved : null,
            webUrl: url,
            now,
          }),
        ];
      },
    );
  },

  async projectLanguages(client, ref) {
    const project = await resolveProject(client, String(ref), {});
    const progress = await listAll(client, `projects/${project.id}/languages/progress`);
    return {
      project: { slug: project.identifier, name: project.name, url: projectUrl(project, '') },
      languages: progress.map((p) => ({
        code: p.languageId,
        name: p.language?.name || p.languageId,
        total: p.phrases.total,
        translated: p.phrases.translated,
        percent: p.translationProgress,
        lastChange: null,
        url: projectUrl(project, p.languageId),
      })),
    };
  },
};
