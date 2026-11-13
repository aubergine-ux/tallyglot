import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';

import { normalizeConfig } from '../src/core.js';
import {
  emptyIndex,
  fetchStars,
  fillStars,
  pruneIndex,
  rankProjects,
  repoOf,
  scanInstance,
} from '../src/findwork.js';
import { linesJson } from '../src/json.js';
import { clientFor } from '../src/platforms/index.js';
import { CONFIG, NOW, fakeFetch, fixture, repo, routes, run } from './helpers.mjs';

const config = normalizeConfig({
  language: 'sq',
  usernames: ['a'],
  instances: [{ id: 'hosted' }, { platform: 'pontoon' }, { platform: 'crowdin', projects: ['1'] }],
});
const [hosted, pontoon, crowdin] = config.instances;
const weblateRoutes = [
  [/\/api\/projects\/[a-z]+\/languages\/$/, fixture('weblate-project-languages-trale')],
  ['/api/projects/?', { ...fixture('weblate-projects'), next: null }],
];

test('repoOf: recognises forges and nothing else', () => {
  assert.deepEqual(repoOf('https://github.com/QuantumPhysique/trale'), {
    host: 'github.com',
    owner: 'QuantumPhysique',
    repo: 'trale',
  });
  assert.deepEqual(repoOf('https://codeberg.org/a/b.git'), {
    host: 'codeberg.org',
    owner: 'a',
    repo: 'b',
  });
  assert.deepEqual(repoOf('http://GitLab.com/a/b/-/tree/main'), {
    host: 'gitlab.com',
    owner: 'a',
    repo: 'b',
  });
  for (const bad of [
    '',
    null,
    'https://example.org/a/b',
    'https://github.com/only-owner',
    'javascript:alert(1)',
  ]) {
    assert.equal(repoOf(bad), null);
  }
});

test('stars: each forge has its own field; failures are "unknown", never an error', async () => {
  const log = [];
  const fetch = fakeFetch(
    [
      ['api.github.com/repos/a/b', { stargazers_count: 1234 }],
      ['codeberg.org/api/v1/repos/a/b', { stars_count: 56 }],
      ['gitlab.com/api/v4/projects/a/b', { star_count: 7 }],
      ['api.github.com/repos/a/limited', 403],
    ],
    log,
  );
  assert.equal(await fetchStars('https://github.com/a/b', { fetch, githubToken: 't' }), 1234);
  assert.equal(log[0].headers.Authorization, 'Bearer t');
  assert.equal(await fetchStars('https://codeberg.org/a/b', { fetch }), 56);
  assert.equal(await fetchStars('https://gitlab.com/a/b', { fetch }), 7);
  assert.equal(await fetchStars('https://github.com/a/limited', { fetch }), null);
  assert.equal(await fetchStars('https://example.org/x', { fetch }), null);
  const offline = async () => {
    throw new TypeError('fetch failed');
  };
  assert.equal(await fetchStars('https://github.com/a/b', { fetch: offline }), null);
});

test('scan: grows across runs, resumes at the cursor, keeps known stars', async () => {
  const index = emptyIndex('sq');
  const client = clientFor(hosted, { fetch: fakeFetch(weblateRoutes) });
  assert.equal(
    await scanInstance(index, hosted, client, { language: 'sq', budget: 2, now: NOW }),
    1,
  );
  assert.deepEqual(Object.keys(index.projects), ['hosted:freeplane']);
  assert.deepEqual(index.sources.hosted.cursor, { page: 1, index: 1 });
  assert.equal(index.sources.hosted.complete, false);
  assert.equal(index.sources.hosted.total, 1829);
  index.projects['hosted:freeplane'].stars = 99;
  index.projects['hosted:freeplane'].starsAt = '2026-11-01T00:00:00.000Z';

  await scanInstance(index, hosted, client, { language: 'sq', budget: 10, now: NOW + 1000 });
  assert.deepEqual(Object.keys(index.projects).sort(), [
    'hosted:arandr',
    'hosted:freeplane',
    'hosted:musicbottle',
  ]);
  assert.equal(index.sources.hosted.complete, true);
  assert.equal(index.sources.hosted.scanned, 3);
  // a full pass starts over and refreshes what it has, without losing stars
  await scanInstance(index, hosted, client, { language: 'sq', budget: 10, now: NOW + 2000 });
  assert.equal(index.projects['hosted:freeplane'].stars, 99);
  assert.equal(index.projects['hosted:freeplane'].platform, 'weblate');
  assert.equal(index.sources.hosted.complete, true);
});

test('scan: no budget, no catalog, rate limits and outages leave the index intact', async () => {
  const index = emptyIndex('sq');
  index.projects['hosted:x'] = { instance: 'hosted', name: 'X' };
  const ok = clientFor(hosted, { fetch: fakeFetch(weblateRoutes) });
  assert.equal(await scanInstance(index, hosted, ok, { language: 'sq', budget: 0 }), 0);
  assert.equal(await scanInstance(index, hosted, ok, { language: 'sq', budget: -5 }), 0);
  assert.equal(
    await scanInstance(index, crowdin, clientFor(crowdin, { fetch: fakeFetch([]) }), {
      language: 'sq',
      budget: 5,
    }),
    0,
  );
  assert.equal(index.sources.crowdin.unsupported, true);
  const limited = clientFor(hosted, { fetch: fakeFetch([[/./, 429]]) });
  await scanInstance(index, hosted, limited, { language: 'sq', budget: 5 });
  assert.equal(index.sources.hosted.error, 'rate limit reached');
  const down = clientFor(hosted, {
    fetch: async () => {
      throw new TypeError('x');
    },
  });
  await scanInstance(index, hosted, down, { language: 'sq', budget: 5 });
  assert.equal(index.sources.hosted.error, 'could not be reached');
  assert.deepEqual(Object.keys(index.projects), ['hosted:x']);
  await scanInstance(index, hosted, ok, { language: 'sq', budget: 5 });
  assert.equal(index.sources.hosted.error, undefined); // cleared by the next good run
});

test('scan: Pontoon is read whole from recorded responses', async () => {
  const index = emptyIndex('sq');
  const client = clientFor(pontoon, {
    fetch: fakeFetch([
      ['/locales/sq/', fixture('pontoon-locale-sq')],
      ['/projects/?', fixture('pontoon-projects')],
    ]),
  });
  await scanInstance(index, pontoon, client, { language: 'sq', budget: 5, now: NOW });
  assert.equal(index.sources.pontoon.complete, true);
  assert.ok(index.projects['pontoon:common-voice']);
  assert.equal(index.projects['pontoon:amo'].platform, 'pontoon');
});

test('stars are filled in a few at a time, oldest first, and prune forgets instances', async () => {
  const index = emptyIndex('sq');
  for (const n of [1, 2, 3]) {
    index.projects[`hosted:p${n}`] = {
      instance: 'hosted',
      web: `https://github.com/o/p${n}`,
      stars: null,
    };
  }
  index.projects['hosted:p3'].starsAt = new Date(NOW - 86400000).toISOString(); // fresh
  index.projects['gone:p'] = { instance: 'gone', web: '' };
  index.sources = { hosted: {}, gone: {} };
  const fetch = fakeFetch([['api.github.com', { stargazers_count: 5 }]]);
  assert.equal(await fillStars(index, { fetch, max: 1, now: NOW }), 1);
  assert.equal(await fillStars(index, { fetch, max: 5, now: NOW }), 1);
  assert.deepEqual(
    [1, 2, 3].map((n) => index.projects[`hosted:p${n}`].stars),
    [5, 5, null],
  );
  pruneIndex(index, ['hosted']);
  assert.deepEqual(Object.keys(index.sources), ['hosted']);
  assert.ok(!index.projects['gone:p']);
});

test('rank: low coverage only, popular first, tracked projects hidden', () => {
  const p = (name, percent, stars, languages, extra = {}) => ({
    name,
    slug: name,
    instance: 'hosted',
    total: 100,
    translated: percent,
    percent,
    stars,
    languages,
    ...extra,
  });
  const index = {
    projects: {
      'hosted:big': p('big', 10, 5000, 40),
      'hosted:mid': p('mid', 0, 300, 10),
      'hosted:nostars-wide': p('nostars-wide', 50, null, 60),
      'hosted:nostars-small': p('nostars-small', 50, null, 5),
      'hosted:zero': p('zero', 20, 0, 90),
      'hosted:done': p('done', 95, 9000, 50),
      'hosted:mine': p('mine', 30, 8000, 50),
      'hosted:empty': p('empty', 0, 10, 5, { total: 0 }),
      'other:x': p('x', 5, 1, 1, { instance: 'other' }),
    },
  };
  const names = (opts) => rankProjects(index, opts).map((r) => r.name);
  const tracked = new Set(['hosted:mine']);
  assert.deepEqual(names({ tracked }), [
    'big',
    'mid',
    'x',
    'zero',
    'nostars-wide',
    'nostars-small',
  ]);
  assert.deepEqual(names({ tracked, maxPercent: 0 }), ['mid']);
  assert.deepEqual(names({ maxPercent: 100 })[0], 'done');
  assert.deepEqual(names({ tracked, instance: 'other' }), ['x']);
  assert.deepEqual(names({ tracked, query: ' NOSTARS ' }), ['nostars-wide', 'nostars-small']);
  assert.deepEqual(names({ tracked, sort: 'least' }).slice(0, 2), ['mid', 'x']);
  assert.deepEqual(names({ tracked, sort: 'most' })[0], 'mid');
  assert.deepEqual(rankProjects(null), []);
  assert.deepEqual(rankProjects({}), []);
});

test('linesJson: one entry per line and round-trips', () => {
  const obj = { version: 1, projects: { b: { n: 2 }, a: { n: 1 } }, language: 'sq' };
  const text = linesJson(obj, 'projects');
  assert.deepEqual(JSON.parse(text), obj);
  assert.equal(text.split('\n').length, 5);
  assert.deepEqual(JSON.parse(linesJson({ days: {} }, 'days')), { days: {} });
  assert.deepEqual(JSON.parse(linesJson({ a: 1 }, 'days')), { a: 1, days: {} });
});

test('build: the index is written, within budget, and survives a config change', async () => {
  const r = await repo({ ...CONFIG, findWork: { requestsPerRun: 3 } });
  const all = routes([
    [/\/api\/projects\/[a-z]+\/languages\/$/, fixture('weblate-project-languages-trale')],
    ['/api/projects/?', { ...fixture('weblate-projects'), next: null }],
    ['/api/v2/projects/?', fixture('pontoon-projects')],
    ['api.github.com/repos', { stargazers_count: 42 }],
  ]);
  try {
    await run(r, { routes: all });
    let index = await r.read('data/findwork.json');
    assert.equal(index.language, 'sq');
    // 3 requests on Weblate = the list + 2 projects; Pontoon is read whole
    assert.equal(index.sources.hosted.scanned, 2);
    assert.equal(index.sources.pontoon.complete, true);
    assert.equal(index.sources.crowdin.unsupported, true);
    await run(r, { routes: all, now: NOW + 86400000 });
    index = await r.read('data/findwork.json');
    assert.equal(index.sources.hosted.scanned, 3);

    // switching the feature off stops the scan and leaves the file alone
    const off = await repo({ ...CONFIG, findWork: { enabled: false } });
    await run(off, { routes: all });
    await assert.rejects(off.read('data/findwork.json'));
    await rm(off.root, { recursive: true });
  } finally {
    await rm(r.root, { recursive: true });
  }
});
