// Helpers shared by the platform adapters.
//
// An adapter is a plain object:
//
//   id, name            identifier used in the config, and display name
//   url                 default address ('' when every instance has its own)
//   tokenRequired       true when the API refuses anonymous requests
//   tokenHint           where a user finds their token
//   browser             false when the API sends no CORS headers (Action only)
//   languageCode(code)  config language -> the platform's spelling of it
//   createClient(opts)  -> HttpClient
//   refresh(client, instance, opts) -> result, see emptyResult()
//
// and optionally
//
//   projectLanguages(client, project) -> coverage of one project in every language
//   catalog(client, opts)             -> projects on the platform, for "Find work"
//
// To add a platform, write one such module and list it in ./index.js.

import { NetworkError, NotFoundError, RateLimitError } from '../api.js';

const round1 = (n) => Math.floor(n * 10) / 10;
export const percent = (part, total) => (total > 0 ? round1((part / total) * 100) : 100);

export const hyphenated = (code) => String(code || '').replace(/_/g, '-');
export const underscored = (code) => String(code || '').replace(/-/g, '_');
export const sameCode = (a, b) => hyphenated(a).toLowerCase() === hyphenated(b).toLowerCase();

export function emptyResult(previous = [], known = {}) {
  return {
    entries: previous,
    known,
    errors: [],
    limited: false,
    retryAfter: null,
    unreachable: false,
    fetched: 0,
    pending: 0,
    moreHistory: false,
  };
}

/** One dashboard entry, in the shape the Weblate code has always produced. */
export function makeEntry({
  instance,
  platform,
  project,
  component,
  language,
  total = 0,
  translated = 0,
  fuzzy = 0,
  approved = null,
  failing = 0,
  suggestions = 0,
  comments = 0,
  lastChange = null,
  webUrl = '',
  translateUrl = '',
  nextUrl = '',
  now,
}) {
  const review = approved !== null && approved !== undefined;
  const path = component.slug ? `${project.slug}/${component.slug}` : project.slug;
  return {
    id: `${instance.id}:${path}`,
    apiUrl: `${platform}:${instance.id}:${path}`,
    instance: instance.id,
    platform,
    project: { slug: project.slug, name: project.name || project.slug, url: project.url || webUrl },
    component: { slug: component.slug || project.slug, name: component.name || project.name },
    language: { code: language.code, name: language.name || '' },
    total,
    translated,
    fuzzy,
    untranslated: Math.max(0, total - translated - fuzzy),
    translatedPercent: percent(translated, total),
    review,
    approved: review ? approved : null,
    approvedPercent: review ? percent(approved, total) : null,
    failing,
    suggestions,
    comments,
    lastChange: lastChange ? new Date(lastChange).toISOString() : null,
    lastContribution: null,
    webUrl,
    translateUrl: translateUrl || webUrl,
    nextUrl: nextUrl || translateUrl || webUrl,
    pinned: false,
    fetchedAt: new Date(now).toISOString(),
  };
}

/**
 * Refresh an instance that is configured as a list of projects. `fetchProject`
 * returns the entries of one project. Rate limits and network failures stop the
 * run and keep the previous entries of everything not reached, like Weblate's.
 */
export async function refreshProjects(client, instance, opts, fetchProject) {
  const { previous = [], freshMs = 0, now = Date.now(), onProgress = () => {} } = opts;
  const out = emptyResult(previous, opts.known || {});
  const adapterName = opts.platformName || instance.name;
  if (opts.tokenRequired && !client.token) {
    out.errors.push(
      `${adapterName} needs an API token. Add one in Settings, or to the TALLYGLOT_TOKENS secret for the Action.`,
    );
    out.needsToken = true;
    return out;
  }
  const old = new Map();
  for (const e of previous) {
    const key = e.project.slug;
    if (!old.has(key)) old.set(key, []);
    old.get(key).push(e);
  }
  const projects = [...new Set(instance.pinned)];
  const entries = [];
  let done = 0;
  for (const [index, project] of projects.entries()) {
    const kept = old.get(projectSlug(project)) || [];
    const age = kept.length ? now - new Date(kept[0].fetchedAt).getTime() : Infinity;
    if (age < freshMs) {
      entries.push(...kept);
      continue;
    }
    try {
      const fresh = await fetchProject(project);
      entries.push(...fresh);
      out.fetched += fresh.length;
    } catch (err) {
      if (err instanceof RateLimitError || err instanceof NetworkError) {
        if (err instanceof RateLimitError) {
          out.limited = true;
          out.retryAfter = err.retryAfter;
        } else {
          out.unreachable = true;
          out.errors.push(err.message);
        }
        const rest = projects.slice(index);
        out.pending = rest.length;
        for (const p of rest) entries.push(...(old.get(projectSlug(p)) || []));
        break;
      }
      entries.push(...kept);
      out.errors.push(
        err instanceof NotFoundError
          ? `Project "${project}" was not found on ${adapterName}.`
          : `Could not read "${project}": ${err.message}`,
      );
    }
    done += 1;
    onProgress({ done, total: projects.length });
  }
  out.entries = entries;
  return out;
}

/** "org/project" and "project" both become the slug used in entry ids. */
export const projectSlug = (ref) => String(ref).trim().replace(/\//g, '--');
