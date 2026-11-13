import assert from 'node:assert/strict';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { WeblateClient } from '../src/api.js';
import {
  coverageBadge,
  coverageChart,
  loadProject,
  maintainerKey,
  maintainerSnippet,
  summarizeLanguages,
  translatorsFromChanges,
} from '../src/maintainer.js';
import { PLATFORMS } from '../src/platforms/index.js';
import { CONFIG, NOW, fakeFetch, fixture, repo, routes, run } from './helpers.mjs';

const lang = (code, percent, lastChange = null, total = 100) => ({
  code,
  name: code.toUpperCase(),
  total,
  translated: Math.round((total * percent) / 100),
  percent,
  lastChange,
  url: `https://w/${code}/`,
});
const weblateRoutes = [
  ['/api/projects/trale/languages/', fixture('weblate-project-languages-trale')],
  ['/api/projects/trale/changes/', fixture('weblate-project-changes')],
  [
    '/api/projects/trale/',
    {
      slug: 'trale',
      name: 'trale',
      web_url: 'https://hosted.weblate.org/projects/trale/',
      web: '',
    },
  ],
];

test('maintainer: summary sorts, averages and marks stale languages', () => {
  const s = summarizeLanguages(
    [
      lang('de', 100, '2025-01-01T00:00:00Z'), // complete is never stale
      lang('sq', 40, '2026-11-01T00:00:00Z'),
      lang('fr', 70, '2026-05-01T00:00:00Z'), // quiet for half a year
      lang('xx', 0, null), // no date known
      lang('empty', 0, null, 0), // no strings: left out
    ],
    { now: NOW },
  );
  assert.deepEqual(
    s.rows.map((l) => [l.code, l.complete, l.stale]),
    [
      ['de', true, false],
      ['fr', false, true],
      ['sq', false, false],
      ['xx', false, false],
    ],
  );
  assert.deepEqual([s.count, s.average, s.complete, s.stale, s.datesKnown], [4, 52.5, 1, 1, true]);
  assert.equal(summarizeLanguages([lang('a', 10)]).datesKnown, false);
  assert.deepEqual(summarizeLanguages([]), {
    rows: [],
    count: 0,
    average: 0,
    complete: 0,
    stale: 0,
    datesKnown: false,
  });
});

test('maintainer: translators come from changes; bots and non-translation changes do not', () => {
  const change = (user, language, timestamp) => ({
    user: user && `https://w/api/users/${user}/`,
    translation: language && `https://w/api/translations/p/c/${language}/`,
    timestamp,
  });
  const people = translatorsFromChanges([
    change('alice', 'sq', '2026-11-01T10:00:00Z'),
    change('alice', 'sq', '2026-11-03T10:00:00+02:00'),
    change('alice', 'de', '2026-10-01T10:00:00Z'),
    change('bob', 'fr', '2026-11-05T10:00:00Z'),
    change('weblate:push', 'fr', '2026-11-06T10:00:00Z'),
    change('anonymous', 'fr', '2026-11-06T10:00:00Z'),
    change('deleted-123', 'fr', '2026-11-06T10:00:00Z'),
    change(null, 'fr', '2026-11-06T10:00:00Z'),
    change('carol', null, '2026-11-06T10:00:00Z'),
    change('d%C3%A9d%C3%A9', 'fr', '2026-01-01T00:00:00Z'),
  ]);
  assert.deepEqual(people, [
    { name: 'alice', changes: 3, last: '2026-11-03T08:00:00.000Z', languages: ['de', 'sq'] },
    { name: 'bob', changes: 1, last: '2026-11-05T10:00:00.000Z', languages: ['fr'] },
    { name: 'dédé', changes: 1, last: '2026-01-01T00:00:00.000Z', languages: ['fr'] },
  ]);
  // the recorded response holds only a repository push by a bot
  assert.deepEqual(translatorsFromChanges(fixture('weblate-project-changes').results), []);
  assert.deepEqual(translatorsFromChanges([]), []);
});

test('maintainer data source: Weblate project from recorded responses', async () => {
  const log = [];
  const client = new WeblateClient({
    baseUrl: 'https://hosted.weblate.org',
    fetch: fakeFetch(weblateRoutes, log),
  });
  const view = await loadProject(PLATFORMS.weblate, client, 'trale');
  assert.equal(view.project.name, 'trale');
  assert.ok(view.languages.length >= 4);
  assert.deepEqual(view.translators, []);
  assert.equal(log.length, 3);
  assert.match(log[2].url, /\/projects\/trale\/changes\/\?action=2&action=4.*page_size=300/);
  const s = summarizeLanguages(view.languages, { now: NOW });
  assert.equal(s.rows[0].percent, 100);
  assert.equal(s.datesKnown, true);
});

test('maintainer data source: translators failing does not lose the coverage', async () => {
  const client = new WeblateClient({
    baseUrl: 'https://hosted.weblate.org',
    fetch: fakeFetch([['/changes/', 500], ...weblateRoutes]),
  });
  const view = await loadProject(PLATFORMS.weblate, client, 'trale');
  assert.equal(view.translators, null);
  assert.ok(view.languages.length);
  await assert.rejects(
    loadProject(
      PLATFORMS.weblate,
      new WeblateClient({ baseUrl: 'https://h', fetch: fakeFetch([]) }),
      'nope',
    ),
    { name: 'NotFoundError' },
  );
});

test('maintainer data source: Pontoon gives coverage, and no translators', async () => {
  const client = PLATFORMS.pontoon.createClient({
    baseUrl: 'https://pontoon.mozilla.org',
    fetch: fakeFetch([
      ['/projects/firefox-for-android/', fixture('pontoon-project-firefox-for-android')],
    ]),
  });
  const view = await loadProject(PLATFORMS.pontoon, client, 'firefox-for-android');
  assert.equal(view.translators, null);
  assert.equal(summarizeLanguages(view.languages).datesKnown, false);
  assert.equal(view.languages.length, 5);
});

test('maintainer: chart, badge, snippet and file names', () => {
  const view = {
    project: { name: 'A <b> & C' },
    languages: Array.from({ length: 20 }, (_, i) => lang(`l${i}`, i * 5)),
  };
  const light = coverageChart(view, 'light');
  assert.match(light, /^<svg xmlns/);
  assert.ok(light.includes('A &#60;b&#62; &#38; C: 20 languages, 47.5% on average'));
  assert.equal(light.match(/font-weight="600">/g).length, 16); // 15 languages + the rest
  assert.ok(light.includes('5 more (average)'));
  assert.ok(light.includes('#ffffff') && coverageChart(view, 'dark').includes('#1d1b18'));
  assert.ok(!/NaN|undefined/.test(light));
  const none = { project: { name: 'x' }, languages: [] };
  assert.ok(coverageChart(none).includes('0 languages, 0% on average'));
  assert.ok(coverageBadge(none).includes('no languages yet'));
  assert.ok(coverageBadge(view).includes('20 languages · 47.5%'));
  assert.equal(maintainerKey('Hosted', 'Org/My Project!'), 'hosted--org-my-project-');
  const html = maintainerSnippet(
    'https://s/',
    'hosted--trale',
    'https://s/?view=maintainer&project=trale',
    'tr"ale',
  );
  assert.match(html, /srcset="https:\/\/s\/maintainer\/hosted--trale-dark\.svg"/);
  assert.match(
    html,
    /<img src="https:\/\/s\/maintainer\/hosted--trale\.svg" alt="tr&quot;ale translation coverage by language">/,
  );
});

test('build: maintainer files are written; a missing project keeps the rest', async () => {
  const r = await repo({
    ...CONFIG,
    maintainer: [
      { instance: 'hosted', project: 'trale' },
      { instance: 'pontoon', project: 'firefox-for-android' },
      { instance: 'hosted', project: 'missing' },
      { instance: 'nowhere', project: 'x' },
      { project: 'no-instance' },
    ],
  });
  const lines = [];
  try {
    await run(r, {
      routes: routes([
        ...weblateRoutes,
        ['/api/v2/projects/firefox-for-android/', fixture('pontoon-project-firefox-for-android')],
      ]),
      log: (l) => lines.push(l),
    });
    assert.deepEqual((await readdir(join(r.root, 'maintainer'))).sort(), [
      'hosted--trale-badge.svg',
      'hosted--trale-dark.svg',
      'hosted--trale.svg',
      'pontoon--firefox-for-android-badge.svg',
      'pontoon--firefox-for-android-dark.svg',
      'pontoon--firefox-for-android.svg',
    ]);
    const data = await r.read('data/maintainer/hosted--trale.json');
    assert.equal(data.project.name, 'trale');
    assert.equal(data.platform, 'weblate');
    assert.match(await r.text('maintainer/hosted--trale.svg'), /trale: \d+ languages/);
    assert.ok(lines.some((l) => /could not read "missing"/.test(l)));
    assert.ok(lines.some((l) => /"nowhere" is not one of the configured instances/.test(l)));
  } finally {
    await rm(r.root, { recursive: true });
  }
});

test('build: a maintainer can run it without a language of their own', async () => {
  const r = await repo({
    instances: [{ id: 'hosted' }],
    maintainer: [{ instance: 'hosted', project: 'trale' }],
  });
  try {
    const result = await run(r, { routes: weblateRoutes, env: {} });
    assert.equal(result.ok, true);
    assert.ok((await r.text('maintainer/hosted--trale.svg')).length > 500);
    assert.deepEqual((await r.read('data/snapshot.json')).instances, {});
  } finally {
    await rm(r.root, { recursive: true });
  }
  const empty = await repo({ instances: [{ id: 'hosted' }] });
  await assert.rejects(run(empty), /"language" is required/);
  await rm(empty.root, { recursive: true });
});
