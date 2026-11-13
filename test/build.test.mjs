// Runs what the GitHub Action runs (scripts/build-data.mjs) in a temporary
// repository, against recorded API responses.

import assert from 'node:assert/strict';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { CONFIG, NOW, repo, routes, run } from './helpers.mjs';

const DAY = 86400000;

test('build: snapshot and badges cover every configured platform', async () => {
  const r = await repo(CONFIG);
  try {
    const result = await run(r);
    assert.equal(result.ok, true);
    const snap = await r.read('data/snapshot.json');
    assert.equal(snap.version, 1);
    assert.deepEqual(Object.keys(snap.instances), ['hosted', 'pontoon', 'crowdin']);
    assert.deepEqual(
      Object.values(snap.instances).map((i) => [i.platform, i.entries.length, i.errors]),
      [
        ['weblate', 1, []],
        ['pontoon', 2, []],
        ['crowdin', 1, []],
      ],
    );
    assert.equal(snap.language.name, 'Albanian');
    const badges = (await readdir(join(r.root, 'badges'))).sort();
    assert.deepEqual(badges, [
      'crowdin--4242.svg',
      'hosted--trale.svg',
      'overall.svg',
      'pontoon--amo.svg',
      'pontoon--firefox.svg',
    ]);
    assert.match(await r.text('badges/overall.svg'), /across 4 projects/);
  } finally {
    await rm(r.root, { recursive: true });
  }
});

test('build: a 1.0 config and a 1.0 snapshot keep working', async () => {
  const v1 = {
    language: 'sq',
    usernames: ['aubergine-ux'],
    instances: [{ id: 'hosted', pinned: [] }],
    staleDays: 30,
    cacheHours: 12,
  };
  const oldEntry = {
    id: 'hosted:old/gone',
    apiUrl: 'https://hosted.weblate.org/api/translations/old/gone/sq/',
    instance: 'hosted',
    project: { slug: 'old', name: 'Old', url: 'https://hosted.weblate.org/projects/old/' },
    component: { slug: 'gone', name: 'Gone' },
    language: { code: 'sq', name: 'Albanian' },
    total: 10,
    translated: 10,
    fuzzy: 0,
    untranslated: 0,
    translatedPercent: 100,
    review: false,
    approved: null,
    approvedPercent: null,
    failing: 0,
    suggestions: 0,
    lastChange: '2026-01-01T00:00:00.000Z',
    lastContribution: '2026-01-01T00:00:00.000Z',
    webUrl: '',
    translateUrl: '',
    pinned: false,
    fetchedAt: '2026-11-11T05:00:00.000Z',
  };
  const r = await repo(v1, {
    'data/snapshot.json': {
      version: 1,
      generatedAt: '2026-11-11T05:00:00.000Z',
      language: { code: 'sq', name: 'Albanian' },
      instances: {
        hosted: {
          name: 'Hosted Weblate',
          url: 'https://hosted.weblate.org',
          fingerprint: '["https://hosted.weblate.org","sq",["aubergine-ux"],[]]',
          updatedAt: '2026-11-11T05:00:00.000Z',
          entries: [oldEntry],
          known: {
            users: { 'aubergine-ux': { since: '2026-11-11T05:00:00.000Z', before: null } },
            translations: { [oldEntry.apiUrl]: { lastContribution: oldEntry.lastContribution } },
            pins: {},
            missing: {},
          },
          errors: [],
        },
      },
    },
  });
  try {
    // The old translation answers 500: its saved numbers must survive.
    await run(r, { routes: routes([['/translations/old/gone/', 500]]), env: {} });
    const snap = await r.read('data/snapshot.json');
    const ids = snap.instances.hosted.entries.map((e) => e.id);
    assert.ok(ids.includes('hosted:old/gone'), 'entry from the 1.0 snapshot is kept');
    assert.equal(
      snap.instances.hosted.fingerprint,
      '["https://hosted.weblate.org","sq",["aubergine-ux"],[]]',
    );
  } finally {
    await rm(r.root, { recursive: true });
  }
});

test('build: one failing platform does not take the others down', async () => {
  const r = await repo(CONFIG);
  try {
    const lines = [];
    const result = await run(r, {
      routes: routes([
        ['/api/v2/locales/sq/', 500],
        ['/projects/4242', 429],
      ]),
      log: (l) => lines.push(l),
    });
    assert.equal(result.ok, true);
    const snap = await r.read('data/snapshot.json');
    assert.equal(snap.instances.hosted.entries.length, 1);
    assert.equal(snap.instances.pontoon.entries.length, 0);
    assert.match(snap.instances.pontoon.errors[0], /HTTP 500/);
    assert.match(snap.instances.crowdin.errors[0], /rate limit/);
  } finally {
    await rm(r.root, { recursive: true });
  }
});

test('build: without a token, token platforms explain themselves', async () => {
  const r = await repo(CONFIG);
  try {
    await run(r, { env: { TALLYGLOT_TOKENS: 'not json' } });
    const snap = await r.read('data/snapshot.json');
    assert.match(snap.instances.crowdin.errors[0], /needs an API token/);
    assert.equal(snap.instances.hosted.entries.length, 1);
  } finally {
    await rm(r.root, { recursive: true });
  }
});

test('build: activity is counted once and history gets a point per day', async () => {
  const r = await repo(CONFIG);
  try {
    await run(r);
    let activity = await r.read('data/activity.json');
    const day = Object.keys(activity.days)[0];
    assert.deepEqual(activity.days[day], { 'hosted:trale': 2 });
    assert.deepEqual(Object.keys(activity.users.hosted), ['aubergine-ux']);
    assert.equal(
      activity.sources.hosted,
      '["https://hosted.weblate.org","sq",["aubergine-ux"],[]]',
    );

    // The next day: the same changes are not offered again and not recounted.
    await run(r, { now: NOW + DAY });
    activity = await r.read('data/activity.json');
    assert.deepEqual(activity.days[day], { 'hosted:trale': 2 });

    const index = await r.read('data/history/index.json');
    assert.deepEqual(index.years, [2026]);
    const history = await r.read('data/history/2026.json');
    assert.deepEqual(Object.keys(history.days), ['2026-11-12', '2026-11-13']);
    const point = history.days['2026-11-12'];
    assert.deepEqual(Object.keys(point.p).sort(), [
      'crowdin:4242',
      'hosted:trale',
      'pontoon:amo',
      'pontoon:firefox',
    ]);
    assert.deepEqual(point.p['crowdin:4242'], [3041, 2631]);
    assert.equal(point.o[3], 4);
    // one line per day keeps the daily commit small
    assert.equal((await r.text('data/history/2026.json')).split('\n').length, 5);
  } finally {
    await rm(r.root, { recursive: true });
  }
});

test('build: a snapshot from 1.0 gets its activity backfilled once', async () => {
  const fp = '["https://hosted.weblate.org","sq",["aubergine-ux"],[]]';
  const r = await repo(
    { language: 'sq', usernames: ['aubergine-ux'], instances: [{ id: 'hosted' }] },
    {
      'data/snapshot.json': {
        version: 1,
        instances: {
          hosted: {
            fingerprint: fp,
            updatedAt: '2026-11-11T05:00:00.000Z',
            entries: [],
            // 1.0 had already read all history, so it would never be offered again
            known: {
              users: { 'aubergine-ux': { since: '2026-11-11T05:00:00.000Z', before: null } },
              translations: {},
              pins: {},
              missing: {},
            },
          },
        },
      },
    },
  );
  try {
    await run(r, { env: {} });
    const activity = await r.read('data/activity.json');
    assert.equal(Object.values(activity.days)[0]['hosted:trale'], 2);
  } finally {
    await rm(r.root, { recursive: true });
  }
});

test('build: year boundary starts a new history file', async () => {
  const r = await repo(CONFIG);
  try {
    await run(r, { now: Date.parse('2026-12-31T23:00:00Z') });
    await run(r, { now: Date.parse('2027-01-01T01:00:00Z') });
    assert.deepEqual((await r.read('data/history/index.json')).years, [2026, 2027]);
    assert.deepEqual(Object.keys((await r.read('data/history/2027.json')).days), ['2027-01-01']);
  } finally {
    await rm(r.root, { recursive: true });
  }
});

test('build: a fork does not inherit the history and alerts it was forked with', async () => {
  const r = await repo(
    { ...CONFIG, usernames: ['someone-else'] },
    {
      'data/history/index.json': { owner: 'sq|aubergine-ux', years: [2025, 2026] },
      'data/history/2025.json': {
        version: 1,
        year: 2025,
        days: { '2025-06-01': { o: [1, 1, 0, 1, 1], p: {} } },
      },
      'data/history/2026.json': {
        version: 1,
        year: 2026,
        days: { '2026-06-01': { o: [1, 1, 0, 1, 1], p: {} } },
      },
      'data/alerts.json': {
        version: 1,
        events: [
          {
            project: 'x',
            name: 'X',
            at: '2026-01-01T00:00:00.000Z',
            added: 1,
            waiting: 1,
            percent: 1,
            url: 'u',
          },
        ],
      },
    },
  );
  try {
    await run(r);
    const index = await r.read('data/history/index.json');
    assert.deepEqual(index, { owner: 'sq|someone-else', years: [2026] });
    assert.deepEqual(Object.keys((await r.read('data/history/2026.json')).days), ['2026-11-12']);
    await assert.rejects(r.read('data/history/2025.json'));
    assert.deepEqual((await r.read('data/alerts.json')).events, []);
    // the same owner keeps everything on the next run
    await run(r, { now: NOW + DAY });
    assert.equal(Object.keys((await r.read('data/history/2026.json')).days).length, 2);
  } finally {
    await rm(r.root, { recursive: true });
  }
});
