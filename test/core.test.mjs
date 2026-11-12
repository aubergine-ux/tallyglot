import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WeblateClient } from '../src/api.js';
import { overallBadge, renderBadge, textWidth } from '../src/badge.js';
import {
  aggregate,
  groupByProject,
  isStale,
  nextStringUrl,
  normalizeConfig,
  parseTranslationUrl,
  refreshInstance,
  sortEntries,
} from '../src/core.js';

const BASE = 'https://weblate.test';
const NOW = new Date('2026-06-01T00:00:00Z').getTime();
const tUrl = (p, c, l = 'sq') => `${BASE}/api/translations/${p}/${c}/${l}/`;

function detail(project, component, { total = 100, translated = 50, fuzzy = 0, review = false, last = '2026-05-30T00:00:00Z' } = {}) {
  return {
    language_code: 'sq',
    language: { name: 'Albanian' },
    component: { slug: component, name: component.toUpperCase(), project: { slug: project, name: `P ${project}`, web_url: `${BASE}/projects/${project}/`, translation_review: review } },
    total,
    translated,
    fuzzy,
    translated_percent: Math.floor((translated / total) * 1000) / 10,
    failing_checks: 0,
    have_suggestion: 0,
    last_change: last,
    web_url: `${BASE}/projects/${project}/${component}/sq/`,
    translate_url: `${BASE}/translate/${project}/${component}/sq/`,
  };
}

/** Fake Weblate: routes is { 'path or url prefix': body | (url) => body | number(status) } */
function fakeFetch(routes, log = []) {
  return async (url) => {
    log.push(url);
    const u = new URL(url);
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => (u.origin + u.pathname).endsWith(k));
    let body = key ? routes[key] : 404;
    if (typeof body === 'function') body = body(u);
    const status = typeof body === 'number' ? body : 200;
    return {
      status,
      ok: status < 400,
      headers: { get: (h) => (status === 429 && h === 'Retry-After' ? '120' : null) },
      json: async () => body,
    };
  };
}

const instance = normalizeConfig({
  language: 'sq',
  instances: [{ id: 'test', url: BASE, usernames: ['alice'], pinned: ['pinned/app'] }],
}).instances[0];

test('normalizeConfig fills presets and inherits usernames', () => {
  const cfg = normalizeConfig({ language: 'sq', usernames: 'a, b', instances: ['hosted', { url: 'weblate.example.org/api/' }] });
  assert.equal(cfg.instances[0].url, 'https://hosted.weblate.org');
  assert.deepEqual(cfg.instances[0].usernames, ['a', 'b']);
  assert.equal(cfg.instances[1].url, 'https://weblate.example.org');
  assert.equal(cfg.staleDays, 30);
});

test('parseTranslationUrl handles categories', () => {
  assert.deepEqual(parseTranslationUrl(tUrl('p', 'cat%252Fcomp')), { project: 'p', component: 'cat%252Fcomp', language: 'sq' });
  assert.equal(parseTranslationUrl(`${BASE}/api/components/p/c/`), null);
});

test('refreshInstance discovers from changes, adds pins, filters language', async () => {
  const log = [];
  const client = new WeblateClient({
    baseUrl: BASE,
    fetch: fakeFetch(
      {
        '/api/changes/': {
          next: null,
          results: [
            { translation: tUrl('alpha', 'ui'), timestamp: '2026-05-20T10:00:00Z' },
            { translation: tUrl('alpha', 'ui'), timestamp: '2026-05-10T10:00:00Z' },
            { translation: tUrl('alpha', 'ui', 'de'), timestamp: '2026-05-21T10:00:00Z' },
            { translation: null, timestamp: '2026-05-22T10:00:00Z' },
          ],
        },
        '/api/translations/alpha/ui/sq/': detail('alpha', 'ui', { review: true }),
        '/api/translations/alpha/ui/sq/statistics/': { approved: 20, approved_percent: 20 },
        '/api/translations/pinned/app/sq/': detail('pinned', 'app', { translated: 100 }),
      },
      log,
    ),
  });
  const res = await refreshInstance(client, instance, { language: 'sq', now: NOW });
  assert.equal(res.entries.length, 2);
  const ui = res.entries.find((e) => e.id === 'test:alpha/ui');
  assert.equal(ui.lastContribution, '2026-05-20T10:00:00.000Z');
  assert.equal(ui.approvedPercent, 20);
  assert.equal(ui.untranslated, 50);
  assert.equal(res.entries.find((e) => e.id === 'test:pinned/app').pinned, true);
  assert.ok(log[0].includes('user=alice') && log[0].includes('action=2'));
  assert.equal(client.requests, 4);

  // Second run only asks for newer changes and skips fresh entries.
  const log2 = [];
  const client2 = new WeblateClient({ baseUrl: BASE, fetch: fakeFetch({ '/api/changes/': { next: null, results: [] } }, log2) });
  const res2 = await refreshInstance(client2, instance, { language: 'sq', known: res.known, previous: res.entries, freshMs: 3600000, now: NOW + 1000 });
  assert.equal(res2.entries.length, 2);
  assert.equal(log2.length, 1);
  assert.ok(log2[0].includes('timestamp_after='));
});

test('rate limit keeps previous data and reports retry time', async () => {
  const previous = [{ id: 'test:alpha/ui', apiUrl: tUrl('alpha', 'ui'), fetchedAt: '2026-05-01T00:00:00Z', total: 10, translated: 1 }];
  const client = new WeblateClient({
    baseUrl: BASE,
    fetch: fakeFetch({ '/api/changes/': { next: null, results: [] }, '/api/translations/alpha/ui/sq/': 429, '/api/translations/pinned/app/sq/': 429 }),
  });
  const res = await refreshInstance(client, instance, {
    language: 'sq',
    known: { users: {}, translations: { [tUrl('alpha', 'ui')]: {} }, pins: {}, missing: {} },
    previous,
    now: NOW,
  });
  assert.equal(res.limited, true);
  assert.equal(res.retryAfter, 120);
  assert.equal(res.entries.length, 1);
  assert.equal(res.entries[0].translated, 1);
});

test('missing translations are dropped and remembered', async () => {
  const client = new WeblateClient({ baseUrl: BASE, fetch: fakeFetch({ '/api/changes/': { next: null, results: [] } }) });
  const res = await refreshInstance(client, instance, { language: 'sq', now: NOW });
  assert.equal(res.entries.length, 0);
  assert.ok(res.known.missing[tUrl('pinned', 'app')]);
});

test('unreachable instance (CORS) is reported, not thrown', async () => {
  const client = new WeblateClient({ baseUrl: BASE, fetch: async () => { throw new TypeError('Failed to fetch'); } });
  const res = await refreshInstance(client, instance, { language: 'sq', now: NOW });
  assert.equal(res.unreachable, true);
});

test('aggregate, stale, sorting and next link', () => {
  const mk = (id, total, translated, extra = {}) => ({
    id, instance: 'i', project: { slug: id[0], name: id[0] }, component: { name: id }, total, translated, fuzzy: 0,
    untranslated: total - translated, translatedPercent: (translated / total) * 100, review: false, pinned: false,
    lastChange: '2026-05-30T00:00:00Z', translateUrl: 'https://w/translate/x/', webUrl: 'https://w/x/', ...extra,
  });
  const entries = [mk('a1', 100, 100), mk('a2', 100, 99), mk('b1', 200, 20, { lastChange: '2026-01-01T00:00:00Z' })];
  const s = aggregate(entries, { now: NOW });
  assert.equal(s.percent, 54.7);
  assert.equal(s.projects, 2);
  assert.equal(s.complete, 1);
  assert.equal(s.stale, 1);
  assert.equal(isStale({ ...entries[0], lastChange: '2020-01-01T00:00:00Z' }, 30, NOW), false);
  assert.deepEqual(sortEntries(entries, 'closest').map((e) => e.id), ['a2', 'b1', 'a1']);
  assert.deepEqual(sortEntries(entries, 'least').map((e) => e.id), ['b1', 'a2', 'a1']);
  assert.equal(nextStringUrl(entries[1]), 'https://w/translate/x/?q=state:empty');
  assert.equal(groupByProject(entries).length, 2);
});

test('badges are valid, escaped SVG', () => {
  const svg = renderBadge({ label: 'A & <B>', message: '87%' });
  assert.ok(svg.startsWith('<svg') && svg.includes('&#38;') && !svg.includes('<B>'));
  assert.ok(textWidth('Albanian') > 40);
  const overall = overallBadge({ label: 'Albanian', stats: { components: 30, projects: 24, percent: 87.04 } });
  assert.ok(overall.includes('87% across 24 projects'));
});
