// "Find work": an index of open-source projects on the configured platforms
// with their coverage in the user's language, grown a little on every run of
// the Action (and on demand in the browser), ranked by popularity.

import { NetworkError, RateLimitError } from './api.js';
import { getPlatform } from './platforms/index.js';

const STAR_TTL = 30 * 86400000;

export const emptyIndex = (language = '') => ({
  version: 1,
  updatedAt: null,
  language,
  sources: {}, // instance id -> { cursor, complete, total, scanned, updatedAt, error }
  projects: {}, // "<instance>:<slug>" -> project
});

/** Where a project's code lives, when its homepage is a known forge. */
export function repoOf(web) {
  const m = /^https?:\/\/(github\.com|codeberg\.org|gitlab\.com)\/([^/\s]+)\/([^/\s#?]+)/i.exec(
    String(web || ''),
  );
  if (!m) return null;
  return { host: m[1].toLowerCase(), owner: m[2], repo: m[3].replace(/\.git$/, '') };
}

/** Star count from the forge's public API, or null when it cannot be told. */
export async function fetchStars(web, { fetch: fetchImpl = globalThis.fetch, githubToken } = {}) {
  const r = repoOf(web);
  if (!r) return null;
  const path = `${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
  const [url, key, headers] = {
    'github.com': [
      `https://api.github.com/repos/${path}`,
      'stargazers_count',
      githubToken ? { Authorization: `Bearer ${githubToken}` } : {},
    ],
    'codeberg.org': [`https://codeberg.org/api/v1/repos/${path}`, 'stars_count', {}],
    'gitlab.com': [
      `https://gitlab.com/api/v4/projects/${encodeURIComponent(`${r.owner}/${r.repo}`)}`,
      'star_count',
      {},
    ],
  }[r.host];
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'tallyglot', ...headers },
    });
    if (!res.ok) return null;
    const n = (await res.json())[key];
    return typeof n === 'number' ? n : null;
  } catch {
    return null;
  }
}

/**
 * Advance the index of one instance by up to `budget` requests. Never throws:
 * a rate limit or an unreachable API leaves the index as it was and notes why.
 */
export async function scanInstance(
  index,
  instance,
  client,
  { language, budget, now = Date.now() },
) {
  const adapter = getPlatform(instance.platform);
  const source = (index.sources[instance.id] ||= { cursor: null, complete: false, scanned: 0 });
  delete source.error;
  if (!adapter.catalog) {
    source.unsupported = true;
    return 0;
  }
  if (budget <= 0) return 0;
  let result;
  try {
    result = await adapter.catalog(client, {
      language: adapter.languageCode(instance.language || language),
      cursor: source.cursor,
      budget,
    });
  } catch (err) {
    source.error =
      err instanceof RateLimitError
        ? 'rate limit reached'
        : err instanceof NetworkError
          ? 'could not be reached'
          : err.message;
    return 0;
  }
  const stamp = new Date(now).toISOString();
  for (const p of result.projects) {
    const key = `${instance.id}:${p.slug}`;
    const prev = index.projects[key];
    index.projects[key] = {
      ...p,
      instance: instance.id,
      platform: instance.platform,
      // Keep a star count already looked up.
      stars: p.stars ?? prev?.stars ?? null,
      starsAt: prev?.starsAt || null,
      scannedAt: stamp,
    };
  }
  source.cursor = result.cursor;
  source.complete = source.complete || result.complete;
  source.total = result.total ?? source.total ?? null;
  source.scanned = Object.values(index.projects).filter((p) => p.instance === instance.id).length;
  source.updatedAt = stamp;
  index.updatedAt = stamp;
  return result.projects.length;
}

/** Look up stars for up to `max` projects that have none, or an old count. */
export async function fillStars(index, { max = 40, now = Date.now(), ...opts }) {
  const due = Object.values(index.projects)
    .filter((p) => repoOf(p.web) && (!p.starsAt || now - Date.parse(p.starsAt) > STAR_TTL))
    .sort((a, b) => (a.starsAt || '').localeCompare(b.starsAt || ''))
    .slice(0, max);
  for (const p of due) {
    const stars = await fetchStars(p.web, opts);
    if (stars !== null) p.stars = stars;
    p.starsAt = new Date(now).toISOString();
  }
  return due.length;
}

/** Drop projects of instances that are no longer configured. */
export function pruneIndex(index, instanceIds) {
  const keep = new Set(instanceIds);
  for (const id of Object.keys(index.sources)) if (!keep.has(id)) delete index.sources[id];
  for (const [key, p] of Object.entries(index.projects)) {
    if (!keep.has(p.instance)) delete index.projects[key];
  }
}

export const FIND_SORTS = {
  // Stars first; projects without a known star count follow, most languages first.
  popular: (a, b) =>
    (b.stars ?? -1) - (a.stars ?? -1) || b.languages - a.languages || b.total - a.total,
  least: (a, b) => a.percent - b.percent || b.total - a.total,
  most: (a, b) => b.total - b.translated - (a.total - a.translated),
};

/**
 * Projects worth a translator's time: coverage at or below `maxPercent`,
 * not already on their dashboard, matching the search.
 */
export function rankProjects(
  index,
  { maxPercent = 80, tracked = new Set(), query = '', instance = 'all', sort = 'popular' } = {},
) {
  const q = query.trim().toLowerCase();
  return Object.entries(index?.projects || {})
    .filter(
      ([key, p]) =>
        p.percent <= maxPercent &&
        p.total > 0 &&
        !tracked.has(key) &&
        (instance === 'all' || p.instance === instance) &&
        (!q || `${p.name} ${p.slug}`.toLowerCase().includes(q)),
    )
    .map(([key, p]) => ({ key, ...p }))
    .sort((a, b) => (FIND_SORTS[sort] || FIND_SORTS.popular)(a, b) || a.name.localeCompare(b.name));
}
