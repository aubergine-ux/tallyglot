// One block per platform adapter, each fed with the responses in test/fixtures.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isStale, nextStringUrl, normalizeConfig } from '../src/core.js';
import { PLATFORMS, clientFor, getPlatform, refreshPlatform } from '../src/platforms/index.js';
import { PLATFORM_META } from '../src/presets.js';
import { fakeFetch, fixture } from './helpers.mjs';

const NOW = new Date('2026-11-12T12:00:00Z').getTime();

function setup(instanceConfig, routes, { token = 'secret', language = 'sq' } = {}) {
  const config = normalizeConfig({ language, usernames: ['alice'], instances: [instanceConfig] });
  const instance = config.instances[0];
  const log = [];
  const client = clientFor(instance, { token, fetch: fakeFetch(routes, log) });
  const run = (opts = {}) =>
    refreshPlatform(client, instance, { language: config.language, now: NOW, ...opts });
  return { config, instance, client, log, run };
}

test('registry: every platform implements the adapter interface', () => {
  assert.deepEqual(Object.keys(PLATFORMS).sort(), Object.keys(PLATFORM_META).sort());
  for (const [id, adapter] of Object.entries(PLATFORMS)) {
    assert.equal(adapter.id, id);
    assert.equal(adapter.name, PLATFORM_META[id].name);
    for (const method of ['createClient', 'refresh', 'languageCode']) {
      assert.equal(typeof adapter[method], 'function', `${id}.${method}`);
    }
    assert.equal(typeof adapter.tokenRequired, 'boolean');
  }
  assert.equal(getPlatform('nope').id, 'weblate');
});

test('config: platform instances get defaults; 1.0 configs are unchanged', () => {
  const v1 = normalizeConfig({
    language: 'sq',
    usernames: ['alice'],
    instances: [{ id: 'hosted', pinned: ['a/b'] }, { url: 'https://weblate.example.org' }],
  });
  assert.deepEqual(
    v1.instances.map((i) => [i.id, i.platform, i.url, i.usernames, i.pinned]),
    [
      ['hosted', 'weblate', 'https://hosted.weblate.org', ['alice'], ['a/b']],
      ['weblate-example-org', 'weblate', 'https://weblate.example.org', ['alice'], []],
    ],
  );
  const v2 = normalizeConfig({
    language: 'pt_BR',
    usernames: ['alice'],
    instances: [
      { platform: 'pontoon' },
      { platform: 'crowdin', projects: ['kestrel-notes'], language: 'pt-BR' },
      { platform: 'transifex', projects: 'heron/heron-desktop' },
      { platform: 'made-up', id: 'hosted' },
    ],
  });
  assert.deepEqual(
    v2.instances.map((i) => [i.id, i.platform, i.url, i.pinned, i.language]),
    [
      ['pontoon', 'pontoon', 'https://pontoon.mozilla.org', [], ''],
      ['crowdin', 'crowdin', 'https://api.crowdin.com', ['kestrel-notes'], 'pt-BR'],
      ['transifex', 'transifex', 'https://rest.api.transifex.com', ['heron/heron-desktop'], ''],
      ['hosted', 'weblate', 'https://hosted.weblate.org', [], ''],
    ],
  );
  assert.deepEqual(v2.instances[0].usernames, []); // usernames only mean something on Weblate
});

test('weblate: recorded translation becomes an entry', async () => {
  const detail = fixture('weblate-translation-trale-localizations-sq');
  const t = 'https://hosted.weblate.org/api/translations/trale/localizations/sq/';
  const { run, log } = setup({ id: 'hosted', usernames: [], pinned: ['trale/localizations'] }, [
    ['/api/changes/', { results: [], next: null }],
    [t, detail],
  ]);
  const out = await run();
  assert.deepEqual(out.errors, []);
  assert.equal(out.entries.length, 1);
  const [e] = out.entries;
  assert.equal(e.id, 'hosted:trale/localizations');
  assert.equal(e.platform, 'weblate');
  assert.equal(e.project.web, 'https://github.com/QuantumPhysique/trale');
  assert.equal(e.total, detail.total);
  assert.equal(e.translated, detail.translated);
  assert.equal(e.translatedPercent, detail.translated_percent);
  assert.equal(e.language.name, 'Albanian');
  assert.equal(e.pinned, true);
  assert.match(nextStringUrl(e), /\/translate\/trale\/localizations\/sq\/\?q=state:empty$/);
  assert.equal(log.at(-1).headers.Authorization, 'Token secret');
});

test('weblate: project languages and catalog from recorded responses', async () => {
  const languages = fixture('weblate-project-languages-trale');
  const projects = fixture('weblate-projects');
  const { client } = setup({ id: 'hosted' }, [
    [/\/api\/projects\/[a-z]+\/languages\/$/, languages],
    [
      '/api/projects/trale/',
      { slug: 'trale', name: 'trale', web_url: 'https://h/projects/trale/' },
    ],
    ['/api/projects/?', { ...projects, next: null }],
  ]);
  const view = await PLATFORMS.weblate.projectLanguages(client, 'trale');
  assert.equal(view.project.name, 'trale');
  const sq = view.languages.find((l) => l.code === 'sq');
  assert.deepEqual([sq.name, sq.percent, sq.total], ['Albanian', 96.6, 272]);
  assert.match(sq.lastChange, /^2026-11-06T/);

  const cat = await PLATFORMS.weblate.catalog(client, { language: 'sq', budget: 3 });
  // 1 request for the list, 2 left for projects; the third project waits for the next call.
  assert.deepEqual(
    cat.projects.map((p) => p.slug),
    ['freeplane', 'arandr'],
  );
  assert.deepEqual(cat.cursor, { page: 1, index: 2 });
  assert.equal(cat.complete, false);
  assert.equal(cat.projects[0].percent, 96.6);
  const rest = await PLATFORMS.weblate.catalog(client, { language: 'sq', cursor: cat.cursor });
  assert.deepEqual(
    rest.projects.map((p) => p.slug),
    ['musicbottle'],
  );
  assert.equal(rest.complete, true);
});

test('pontoon: one request lists every project of the locale', async () => {
  const locale = fixture('pontoon-locale-sq');
  const { run, log } = setup({ platform: 'pontoon' }, [['/api/v2/locales/sq/', locale]], {
    token: '',
  });
  const out = await run();
  assert.deepEqual(out.errors, []);
  assert.equal(log.length, 1);
  assert.equal(out.entries.length, locale.localizations.length);
  const amo = out.entries.find((e) => e.project.slug === 'amo');
  const raw = locale.localizations.find((l) => l.project.slug === 'amo');
  assert.equal(amo.id, 'pontoon:amo');
  assert.equal(amo.platform, 'pontoon');
  assert.equal(amo.total, raw.total_strings);
  assert.equal(amo.translated, raw.completed_strings);
  assert.equal(amo.untranslated, raw.missing_strings);
  assert.equal(amo.language.name, 'Albanian');
  assert.equal(amo.webUrl, 'https://pontoon.mozilla.org/sq/amo/');
  assert.equal(
    nextStringUrl(amo),
    'https://pontoon.mozilla.org/sq/amo/all-resources/?status=missing',
  );
  assert.equal(isStale(amo, 30, NOW), false); // Pontoon reports no activity date
});

test('pontoon: "projects" narrows the list, unknown ones are reported', async () => {
  const { run } = setup(
    { platform: 'pontoon', projects: ['firefox', 'nope'] },
    [['/api/v2/locales/sq/', fixture('pontoon-locale-sq')]],
    { token: '' },
  );
  const out = await run();
  assert.deepEqual(
    out.entries.map((e) => e.project.slug),
    ['firefox'],
  );
  assert.match(out.errors[0], /"nope" is not enabled for sq/);
});

test('pontoon: locale codes use hyphens; a missing locale is explained', async () => {
  const { run, log } = setup({ platform: 'pontoon' }, [], { token: '', language: 'pt_BR' });
  const out = await run();
  assert.match(log[0].url, /\/locales\/pt-BR\/$/);
  assert.match(out.errors[0], /no "pt-BR" locale/);
  assert.deepEqual(out.entries, []);
});

test('pontoon: project languages and catalog from recorded responses', async () => {
  const { client } = setup(
    { platform: 'pontoon' },
    [
      ['/projects/firefox-for-android/', fixture('pontoon-project-firefox-for-android')],
      ['/locales/sq/', fixture('pontoon-locale-sq')],
      ['/projects/?', fixture('pontoon-projects')],
    ],
    { token: '' },
  );
  const view = await PLATFORMS.pontoon.projectLanguages(client, 'firefox-for-android');
  assert.equal(view.project.name, 'Firefox for Android');
  const sq = view.languages.find((l) => l.code === 'sq');
  assert.deepEqual([sq.total, sq.translated, sq.percent], [2607, 2338, 89.6]);

  const cat = await PLATFORMS.pontoon.catalog(client, { language: 'sq' });
  assert.equal(cat.complete, true);
  const fa = cat.projects.find((p) => p.slug === 'firefox-for-android');
  assert.equal(fa.started, true);
  assert.equal(fa.percent, 89.6);
  assert.equal(fa.url, 'https://pontoon.mozilla.org/sq/firefox-for-android/');
});

test('crowdin: identifier is resolved, progress becomes one entry per project', async () => {
  const { run, log } = setup({ platform: 'crowdin', projects: ['kestrel-notes'] }, [
    ['/projects/4242/languages/progress', fixture('crowdin-progress')],
    [/\/api\/v2\/projects\?/, fixture('crowdin-projects')],
  ]);
  const out = await run();
  assert.deepEqual(out.errors, []);
  assert.equal(out.entries.length, 1);
  const [e] = out.entries;
  assert.equal(e.id, 'crowdin:kestrel-notes');
  assert.equal(e.project.name, 'Kestrel Notes');
  assert.deepEqual([e.total, e.translated, e.approved, e.untranslated], [3041, 2631, 2622, 410]);
  assert.equal(e.translatedPercent, 86.5);
  assert.equal(e.review, true);
  assert.equal(e.webUrl, 'https://crowdin.com/project/kestrel-notes/sq');
  assert.equal(log[0].headers.Authorization, 'Bearer secret');
});

test('crowdin: numeric ids skip the lookup; language codes use hyphens', async () => {
  const { run, log } = setup(
    { platform: 'crowdin', projects: ['4242'] },
    [
      ['/projects/4242/languages/progress', fixture('crowdin-progress')],
      ['/projects/4242', fixture('crowdin-project')],
    ],
    { language: 'pt_BR' },
  );
  const out = await run();
  assert.equal(out.entries[0].language.code, 'pt-BR');
  assert.equal(out.entries[0].translated, 610);
  assert.equal(out.entries[0].review, false);
  assert.equal(log.length, 2);
});

test('transifex: follows pagination, one entry per resource', async () => {
  const { run, log } = setup(
    { platform: 'transifex', projects: ['heron/heron-desktop'] },
    [
      ['page[cursor]=abc', fixture('transifex-stats-page2')],
      ['/resource_language_stats', fixture('transifex-stats-page1')],
      ['/resources', fixture('transifex-resources')],
      ['/projects/o:heron:p:heron-desktop', fixture('transifex-project')],
    ],
    { language: 'pt-BR' },
  );
  const out = await run();
  assert.deepEqual(out.errors, []);
  assert.deepEqual(
    out.entries.map((e) => [e.id, e.component.name, e.total, e.translated, e.approved]),
    [
      ['transifex:heron--heron-desktop/app', 'Application', 820, 750, 400],
      ['transifex:heron--heron-desktop/website', 'Website', 140, 140, null],
    ],
  );
  assert.equal(out.entries[0].project.name, 'Heron Desktop');
  assert.equal(out.entries[0].lastChange, '2026-11-07T16:30:00.000Z');
  assert.equal(
    out.entries[0].translateUrl,
    'https://app.transifex.com/heron/heron-desktop/translate/#pt_BR/app',
  );
  assert.ok(log.some((r) => r.url.includes('filter[language]=l:pt_BR')));
  assert.equal(log[0].headers.Accept, 'application/vnd.api+json');
  assert.equal(log[0].headers.Authorization, 'Bearer secret');
});

test('lokalise: project statistics become one entry', async () => {
  const id = '3002780358964f9bab5a92.87762432';
  const { run, log } = setup({ platform: 'lokalise', projects: [id] }, [
    [`/api2/projects/${id}`, fixture('lokalise-project')],
  ]);
  const out = await run();
  assert.deepEqual(out.errors, []);
  const [e] = out.entries;
  assert.equal(e.project.name, 'Osprey Mobile');
  assert.deepEqual([e.total, e.translated, e.translatedPercent], [1200, 768, 64]);
  assert.equal(log[0].headers['X-Api-Token'], 'secret');
  const view = await PLATFORMS.lokalise.projectLanguages(
    clientFor(normalizeConfig({ instances: [{ platform: 'lokalise' }] }).instances[0], {
      token: 'x',
      fetch: fakeFetch([[`/api2/projects/${id}`, fixture('lokalise-project')]]),
    }),
    id,
  );
  assert.deepEqual(
    view.languages.map((l) => l.code),
    ['sq', 'pt_BR'],
  );
});

for (const platform of ['crowdin', 'transifex', 'lokalise']) {
  test(`${platform}: without a token nothing is requested and the reason is given`, async () => {
    const { run, log } = setup({ platform, projects: ['a/b'] }, [], { token: '' });
    const out = await run({ previous: [{ project: { slug: 'a--b' }, fetchedAt: '2026-01-01' }] });
    assert.equal(log.length, 0);
    assert.equal(out.entries.length, 1); // previous data is kept
    assert.match(out.errors[0], /needs an API token/);
  });

  test(`${platform}: failures keep previous data and never throw`, async () => {
    const previous = [
      { id: 'x', project: { slug: 'a--b' }, fetchedAt: new Date(NOW - 86400000).toISOString() },
    ];
    for (const [status, check] of [
      [429, (o) => assert.equal(o.limited, true) || assert.equal(o.retryAfter, 120)],
      [404, (o) => assert.match(o.errors[0], /not found|Could not read/)],
      [500, (o) => assert.match(o.errors[0], /HTTP 500/)],
    ]) {
      const { run } = setup({ platform, projects: ['a/b'] }, [[/./, status]]);
      const out = await run({ previous });
      assert.deepEqual(out.entries, previous, `HTTP ${status}`);
      check(out);
    }
    const { instance, config } = setup({ platform, projects: ['a/b'] }, []);
    const offline = clientFor(instance, {
      token: 't',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const out = await refreshPlatform(offline, instance, {
      language: config.language,
      previous,
      now: NOW,
    });
    assert.equal(out.unreachable, true);
    assert.deepEqual(out.entries, previous);
  });
}
