// Discovery, statistics and aggregation. Shared by the browser app and the
// Node script that the GitHub Action runs, so both produce identical data.

import { NetworkError, NotFoundError, RateLimitError, normalizeBaseUrl } from './api.js';
import { PRESETS, slugifyId } from './presets.js';

// Change actions that mean "this user worked on a translation":
// changed, suggestion added, translation added, suggestion accepted,
// reverted, uploaded, approved, marked for edit.
export const TRANSLATION_ACTIONS = [2, 4, 5, 7, 8, 9, 36, 37];

const DAY = 86400000;
const PIN_TTL = 7 * DAY;
const MISSING_TTL = 7 * DAY;

export const DEFAULTS = {
  staleDays: 30,
  cacheHours: 12,
  discoveryPages: 3,
};

const list = (v) =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n]/) : [])
    .map((s) => String(s).trim())
    .filter(Boolean);

/** Fill in defaults and presets so the rest of the code can trust the shape. */
export function normalizeConfig(raw = {}) {
  const globalUsers = list(raw.usernames);
  const seen = new Set();
  const instances = (raw.instances || []).map((item) => {
    const src = typeof item === 'string' ? { id: item } : { ...item };
    const preset =
      PRESETS.find((p) => p.id === src.id) ||
      PRESETS.find((p) => src.url && normalizeBaseUrl(src.url) === p.url);
    const url = normalizeBaseUrl(src.url || preset?.url);
    let id = slugifyId(src.id || preset?.id || url);
    while (seen.has(id)) id += '-2';
    seen.add(id);
    const own = list(src.usernames);
    return {
      id,
      name: src.name || preset?.name || url.replace(/^https?:\/\//, ''),
      url,
      usernames: own.length ? own : globalUsers,
      pinned: list(src.pinned),
      enabled: src.enabled !== false,
    };
  });
  return {
    language: String(raw.language || '').trim(),
    languageName: String(raw.languageName || '').trim(),
    usernames: globalUsers,
    instances: instances.filter((i) => i.url),
    staleDays: Number(raw.staleDays) > 0 ? Number(raw.staleDays) : DEFAULTS.staleDays,
    cacheHours:
      Number(raw.cacheHours) >= 0 && raw.cacheHours !== undefined && raw.cacheHours !== ''
        ? Number(raw.cacheHours)
        : DEFAULTS.cacheHours,
    discoveryPages:
      Number(raw.discoveryPages) > 0 ? Number(raw.discoveryPages) : DEFAULTS.discoveryPages,
    badgeLabel: String(raw.badgeLabel || '').trim(),
  };
}

/** Identifies what a set of entries was fetched for, to detect config changes. */
export function instanceFingerprint(instance, language) {
  return JSON.stringify([
    instance.url,
    language.toLowerCase(),
    [...instance.usernames].map((u) => u.toLowerCase()).sort(),
    [...instance.pinned].sort(),
  ]);
}

/** "https://x/api/translations/proj/comp/sq/" -> { project, component, language } */
export function parseTranslationUrl(url) {
  const m = /\/api\/translations\/(.+?)\/?$/.exec(String(url || '').split('?')[0]);
  if (!m) return null;
  const parts = m[1].split('/');
  if (parts.length < 3) return null;
  return {
    project: parts[0],
    component: parts.slice(1, -1).join('/'),
    language: parts[parts.length - 1],
  };
}

function translationUrl(baseUrl, project, component, language) {
  return `${baseUrl}/api/translations/${project}/${component}/${language}/`;
}

const sameLang = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export function emptyKnown() {
  return { users: {}, translations: {}, pins: {}, missing: {} };
}

/**
 * Find the translations a user has contributed to by reading their change
 * history, newest first. Each run reads what is new since the previous run,
 * and, while older history remains, another `pages` thousand changes of it.
 * A very long history is therefore walked back over several runs.
 */
export async function discover(client, { usernames, language, known, pages, now }) {
  const errors = [];
  const record = (changes) => {
    let oldest = null;
    for (const change of changes) {
      const stamp = change.timestamp ? new Date(change.timestamp).toISOString() : null;
      if (stamp && (!oldest || stamp < oldest)) oldest = stamp;
      const parsed = parseTranslationUrl(change.translation);
      if (!parsed || !sameLang(parsed.language, language)) continue;
      const prev = known.translations[change.translation];
      if (!prev) known.translations[change.translation] = { lastContribution: stamp };
      else if (stamp && (!prev.lastContribution || stamp > prev.lastContribution)) {
        prev.lastContribution = stamp;
      }
      delete known.missing[change.translation];
    }
    return oldest;
  };

  for (const username of usernames) {
    // { since: read everything newer than this, before: history older than this is unread }
    const saved = known.users[username];
    const state = typeof saved === 'string' ? { since: saved, before: null } : { ...saved };
    const query = { user: username, action: TRANSLATION_ACTIONS, page_size: 1000 };
    try {
      const fresh = await client.getPaged(
        'changes/',
        { ...query, timestamp_after: state.since },
        pages,
      );
      const oldestFresh = record(fresh.results);
      if (!state.since) {
        state.before = fresh.complete ? null : oldestFresh;
      } else if (state.before) {
        const older = await client.getPaged(
          'changes/',
          { ...query, timestamp_before: state.before },
          pages,
        );
        const oldest = record(older.results);
        state.before = older.complete || !oldest || oldest === state.before ? null : oldest;
      }
      state.since = new Date(now).toISOString();
      known.users[username] = state;
    } catch (err) {
      if (err instanceof RateLimitError || err instanceof NetworkError) throw err;
      errors.push(`Could not read contributions of "${username}": ${err.message}`);
    }
  }
  return errors;
}

/** True while some username still has older history left to read. */
export function hasUnreadHistory(known) {
  return Object.values(known?.users || {}).some((u) => u && typeof u === 'object' && u.before);
}

/** Turn pins ("project/component", "project" or "project/*") into translation URLs. */
export async function resolvePins(client, { pinned, language, known, now }) {
  const urls = [];
  const errors = [];
  for (const pin of pinned) {
    const parts = pin.replace(/^\/+|\/+$/g, '').split('/');
    const project = parts[0];
    const rest = parts.slice(1);
    if (rest.length && rest[0] !== '*') {
      // Components inside categories are addressed as category%252Fcomponent.
      urls.push(translationUrl(client.baseUrl, project, rest.join('%252F'), language));
      continue;
    }
    const cached = known.pins[project];
    if (cached && now - new Date(cached.at).getTime() < PIN_TTL) {
      urls.push(...cached.components.map((c) => `${c}${language}/`));
      continue;
    }
    try {
      const { results } = await client.getPaged(
        `projects/${project}/components/`,
        { page_size: 1000 },
        5,
      );
      const components = results
        .map((c) => String(c.url || '').replace('/api/components/', '/api/translations/'))
        .filter(Boolean);
      known.pins[project] = { at: new Date(now).toISOString(), components };
      urls.push(...components.map((c) => `${c}${language}/`));
    } catch (err) {
      if (err instanceof RateLimitError || err instanceof NetworkError) throw err;
      if (cached) urls.push(...cached.components.map((c) => `${c}${language}/`));
      errors.push(`Could not expand pinned project "${project}": ${err.message}`);
    }
  }
  return { urls, errors };
}

const round1 = (n) => Math.floor(n * 10) / 10;
const pct = (part, total) => (total > 0 ? round1((part / total) * 100) : 100);

/** Build a dashboard entry from the API translation object (+ optional statistics). */
export function buildEntry({ detail, stats, instance, apiUrl, lastContribution, pinned, now }) {
  const parsed = parseTranslationUrl(apiUrl);
  const component = detail.component || {};
  const project = component.project || {};
  const total = detail.total ?? 0;
  const translated = detail.translated ?? 0;
  const fuzzy = detail.fuzzy ?? 0;
  const review = stats != null;
  return {
    id: `${instance.id}:${parsed.project}/${parsed.component}`,
    apiUrl,
    instance: instance.id,
    project: {
      slug: project.slug || parsed.project,
      name: project.name || parsed.project,
      url: project.web_url || `${instance.url}/projects/${parsed.project}/`,
    },
    component: {
      slug: component.slug || parsed.component,
      name: component.name || parsed.component,
    },
    language: { code: detail.language_code || parsed.language, name: detail.language?.name || '' },
    total,
    translated,
    fuzzy,
    untranslated: Math.max(0, total - translated - fuzzy),
    translatedPercent: detail.translated_percent ?? pct(translated, total),
    review,
    approved: review ? (stats.approved ?? 0) : null,
    approvedPercent: review ? (stats.approved_percent ?? 0) : null,
    failing: detail.failing_checks ?? 0,
    suggestions: detail.have_suggestion ?? 0,
    lastChange: detail.last_change ? new Date(detail.last_change).toISOString() : null,
    lastContribution: lastContribution || null,
    webUrl: detail.web_url || '',
    translateUrl: detail.translate_url || '',
    pinned: !!pinned,
    fetchedAt: new Date(now).toISOString(),
  };
}

/** Link that opens the next string needing work in Weblate's editor. */
export function nextStringUrl(entry) {
  if (!entry.translateUrl) return entry.webUrl;
  if (entry.untranslated > 0) return `${entry.translateUrl}?q=state:empty`;
  if (entry.fuzzy > 0) return `${entry.translateUrl}?q=state:needs-editing`;
  if (entry.review && entry.approved < entry.total)
    return `${entry.translateUrl}?q=state:translated`;
  return entry.webUrl || entry.translateUrl;
}

export const isComplete = (e) => e.total > 0 && e.translated >= e.total;

export function daysSince(iso, now = Date.now()) {
  if (!iso) return Infinity;
  return (now - new Date(iso).getTime()) / DAY;
}

/** Stale = still has work left, and nobody touched it for `staleDays`. */
export function isStale(entry, staleDays = DEFAULTS.staleDays, now = Date.now()) {
  return !isComplete(entry) && daysSince(entry.lastChange, now) >= staleDays;
}

/**
 * Refresh one instance. Never throws for rate limits: it returns what it
 * managed to fetch, keeps previous data for the rest, and reports `limited`.
 *
 * @returns {{entries: object[], known: object, errors: string[],
 *            limited: boolean, retryAfter: number|null, unreachable: boolean,
 *            fetched: number, pending: number, moreHistory: boolean}}
 */
export async function refreshInstance(client, instance, opts) {
  const {
    language,
    previous = [],
    discoveryPages = DEFAULTS.discoveryPages,
    freshMs = 0,
    now = Date.now(),
    onProgress = () => {},
  } = opts;
  const known = structuredClone(opts.known || emptyKnown());
  for (const key of Object.keys(emptyKnown())) known[key] ||= {};

  const out = {
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
  const stop = (err) => {
    if (err instanceof RateLimitError) {
      out.limited = true;
      out.retryAfter = err.retryAfter;
      return true;
    }
    if (err instanceof NetworkError) {
      out.unreachable = true;
      out.errors.push(err.message);
      return true;
    }
    return false;
  };

  let pinUrls = [];
  try {
    out.errors.push(
      ...(await discover(client, {
        usernames: instance.usernames,
        language,
        known,
        pages: discoveryPages,
        now,
      })),
    );
    const pins = await resolvePins(client, { pinned: instance.pinned, language, known, now });
    pinUrls = pins.urls;
    out.errors.push(...pins.errors);
  } catch (err) {
    if (!stop(err)) throw err;
    return out;
  }

  const pinSet = new Set(pinUrls);
  const byUrl = new Map(previous.map((e) => [e.apiUrl, e]));
  const targets = [...new Set([...Object.keys(known.translations), ...pinUrls])].filter((url) => {
    const missingAt = known.missing[url];
    return !(missingAt && now - new Date(missingAt).getTime() < MISSING_TTL);
  });
  const age = (url) => (byUrl.has(url) ? new Date(byUrl.get(url).fetchedAt).getTime() : 0);
  // Oldest data first, so a refresh cut short by a rate limit resumes fairly.
  const queue = targets.filter((url) => now - age(url) >= freshMs).sort((a, b) => age(a) - age(b));

  const results = new Map();
  for (const url of targets) if (byUrl.has(url)) results.set(url, byUrl.get(url));

  let halted = false;
  let done = 0;
  const worker = async () => {
    while (queue.length && !halted) {
      const url = queue.shift();
      try {
        const detail = await client.get(url);
        if (detail.is_source) {
          known.missing[url] = new Date(now).toISOString();
          results.delete(url);
        } else {
          let stats = null;
          if (detail.component?.project?.translation_review) {
            stats = await client.get(`${url}statistics/`);
          }
          results.set(
            url,
            buildEntry({
              detail,
              stats,
              instance,
              apiUrl: url,
              lastContribution: known.translations[url]?.lastContribution,
              pinned: pinSet.has(url),
              now,
            }),
          );
          out.fetched += 1;
        }
      } catch (err) {
        if (err instanceof NotFoundError) {
          known.missing[url] = new Date(now).toISOString();
          results.delete(url);
        } else if (stop(err)) {
          queue.unshift(url);
          halted = true;
        } else {
          out.errors.push(err.message);
        }
      }
      done += 1;
      onProgress({ done, total: done + queue.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));

  out.pending = queue.length;
  out.moreHistory = hasUnreadHistory(known);
  out.entries = [...results.values()].map((e) => ({
    ...e,
    pinned: pinSet.has(e.apiUrl),
    lastContribution: known.translations[e.apiUrl]?.lastContribution || e.lastContribution,
  }));
  return out;
}

/** Totals across a list of entries, weighted by string count. */
export function aggregate(entries, { staleDays = DEFAULTS.staleDays, now = Date.now() } = {}) {
  const sum = (key) => entries.reduce((n, e) => n + (e[key] || 0), 0);
  const total = sum('total');
  const translated = sum('translated');
  const reviewed = entries.filter((e) => e.review);
  const reviewTotal = reviewed.reduce((n, e) => n + e.total, 0);
  const approved = reviewed.reduce((n, e) => n + (e.approved || 0), 0);
  const lastChange = entries.reduce(
    (latest, e) => (e.lastChange && e.lastChange > latest ? e.lastChange : latest),
    '',
  );
  return {
    components: entries.length,
    projects: new Set(entries.map((e) => `${e.instance}:${e.project.slug}`)).size,
    instances: new Set(entries.map((e) => e.instance)).size,
    total,
    translated,
    percent: entries.length ? pct(translated, total) : 0,
    approvedPercent: reviewTotal ? pct(approved, reviewTotal) : null,
    untranslated: sum('untranslated'),
    fuzzy: sum('fuzzy'),
    complete: entries.filter(isComplete).length,
    stale: entries.filter((e) => isStale(e, staleDays, now)).length,
    lastChange: lastChange || null,
  };
}

/** Group entries by project (per instance), with string-weighted totals. */
export function groupByProject(entries) {
  const groups = new Map();
  for (const e of entries) {
    const key = `${e.instance}:${e.project.slug}`;
    if (!groups.has(key)) {
      groups.set(key, { key, instance: e.instance, project: e.project, entries: [] });
    }
    groups.get(key).entries.push(e);
  }
  return [...groups.values()].map((g) => ({ ...g, stats: aggregate(g.entries) }));
}

export const SORTS = {
  least: { label: 'Least complete', fn: (a, b) => a.translatedPercent - b.translatedPercent },
  most: { label: 'Most complete', fn: (a, b) => b.translatedPercent - a.translatedPercent },
  closest: {
    label: 'Closest to 100%',
    // Unfinished work first, nearest to done on top; finished ones sink.
    fn: (a, b) =>
      isComplete(a) - isComplete(b) ||
      b.translatedPercent - a.translatedPercent ||
      a.untranslated + a.fuzzy - (b.untranslated + b.fuzzy),
  },
  fewest: {
    label: 'Fewest strings left',
    fn: (a, b) =>
      isComplete(a) - isComplete(b) || a.total - a.translated - (b.total - b.translated),
  },
  recent: {
    label: 'Recently active',
    fn: (a, b) => (b.lastChange || '').localeCompare(a.lastChange || ''),
  },
  stalest: {
    label: 'Longest inactive',
    fn: (a, b) => (a.lastChange || '').localeCompare(b.lastChange || ''),
  },
  name: {
    label: 'Name',
    fn: (a, b) =>
      a.project.name.localeCompare(b.project.name) ||
      a.component.name.localeCompare(b.component.name),
  },
};

export function sortEntries(entries, sortKey) {
  const sort = SORTS[sortKey] || SORTS.closest;
  return [...entries].sort(
    (a, b) => b.pinned - a.pinned || sort.fn(a, b) || a.id.localeCompare(b.id),
  );
}
