import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeConfig } from '../src/core.js';
import { portfolioData, projectLogo, toJsonResume } from '../src/portfolio.js';

const entry = (instance, project, total, translated, extra = {}) => ({
  instance,
  platform: extra.platform || 'weblate',
  project: {
    slug: project,
    name: project.toUpperCase(),
    url: `https://w/${project}/`,
    web: extra.web || '',
  },
  component: { slug: 'c' },
  language: { code: extra.code || 'sq', name: extra.language ?? 'Albanian' },
  total,
  translated,
  fuzzy: 0,
  untranslated: total - translated,
});
const activity = {
  days: {
    '2024-03-02': { 'h:alpha': 5 },
    '2025-06-01': { 'h:alpha': 20, 'h:beta': 2 },
    '2026-11-10': { 'h:beta': 1 },
  },
};
const config = normalizeConfig({
  language: 'sq',
  usernames: ['alice'],
  displayName: 'Alice Example',
});

test('portfolio: totals, per-project periods, languages and ordering', () => {
  const data = portfolioData({
    entries: [
      entry('h', 'alpha', 100, 100, { web: 'https://github.com/Org/alpha' }),
      entry('h', 'beta', 200, 50),
      entry('c', 'gamma', 400, 300, {
        platform: 'crowdin',
        code: 'pt-BR',
        language: 'Portuguese, Brazilian',
      }),
    ],
    activity,
    config,
    languageName: 'Albanian',
    today: '2026-11-12',
  });
  assert.equal(data.name, 'Alice Example');
  assert.equal(data.since, '2024-03-02');
  assert.deepEqual(data.totals, {
    translated: 450,
    projects: 3,
    complete: 1,
    contributions: 28,
    platforms: 2,
  });
  assert.deepEqual(
    data.projects.map((p) => [p.name, p.contributions, p.since, p.until, p.complete, p.platform]),
    [
      ['ALPHA', 25, '2024-03-02', '2025-06-01', true, 'Weblate'],
      ['BETA', 3, '2025-06-01', '2026-11-10', false, 'Weblate'],
      ['GAMMA', 0, null, null, false, 'Crowdin'],
    ],
  );
  assert.equal(data.projects[0].logo, 'https://github.com/Org.png?size=96');
  assert.equal(data.projects[1].logo, '');
  assert.deepEqual(data.languages, [
    { code: 'pt-BR', name: 'Portuguese, Brazilian', projects: 1, translated: 300 },
    { code: 'sq', name: 'Albanian', projects: 2, translated: 150 },
  ]);
  assert.ok(data.earned.some((a) => a.id === 'complete-1'));
});

test('portfolio: logos only from forges that serve them', () => {
  assert.equal(
    projectLogo('https://codeberg.org/forgejo/forgejo'),
    'https://codeberg.org/forgejo.png?size=96',
  );
  assert.equal(projectLogo('https://gitlab.com/a/b'), '');
  assert.equal(projectLogo('https://example.org'), '');
  assert.equal(projectLogo(''), '');
  assert.equal(projectLogo(undefined), '');
});

test('portfolio: nothing configured, no activity, old entries without new fields', () => {
  const empty = portfolioData({
    entries: [],
    activity: null,
    config: normalizeConfig({}),
    languageName: '',
  });
  assert.deepEqual(empty.totals, {
    translated: 0,
    projects: 0,
    complete: 0,
    contributions: 0,
    platforms: 0,
  });
  assert.deepEqual(
    [empty.name, empty.since, empty.projects, empty.languages, empty.earned],
    ['', null, [], [], []],
  );
  const old = entry('h', 'alpha', 10, 5);
  delete old.platform;
  delete old.project.web;
  old.language = { code: 'sq', name: '' }; // 1.0 snapshots sometimes had no language name
  const data = portfolioData({ entries: [old], activity: null, config, languageName: 'Albanian' });
  assert.deepEqual(
    [data.projects[0].platform, data.projects[0].language, data.projects[0].logo],
    ['Weblate', 'Albanian', ''],
  );
  const team = portfolioData({
    entries: [],
    activity: null,
    config: normalizeConfig({ team: { name: 'Ekipi' }, usernames: ['a'] }),
    languageName: '',
  });
  assert.deepEqual([team.name, team.team], ['Ekipi', true]);
});

test('portfolio: JSON Resume entries follow the schema', () => {
  const data = portfolioData({
    entries: [
      entry('h', 'alpha', 1500, 1500, { web: 'https://github.com/Org/alpha' }),
      entry('h', 'beta', 200, 50),
    ],
    activity,
    config,
    languageName: 'Albanian',
    today: '2026-11-12',
  });
  const resume = toJsonResume(data, { site: 'https://alice.example/tallyglot/?view=portfolio' });
  assert.match(resume.$schema, /jsonresume\/resume-schema\/v1\.0\.0\/schema\.json$/);
  assert.deepEqual(resume.basics, {
    name: 'Alice Example',
    label: 'Translator',
    url: 'https://alice.example/tallyglot/?view=portfolio',
    summary: 'Open-source translator: 1,550 strings across 2 projects (Albanian).',
  });
  assert.deepEqual(resume.volunteer[0], {
    organization: 'ALPHA',
    position: 'Albanian translator',
    url: 'https://github.com/Org/alpha',
    startDate: '2024-03-02',
    endDate: '2025-06-01',
    summary: 'Translated ALPHA into Albanian on Weblate.',
    highlights: [
      '1,500 of 1,500 strings translated (100%)',
      '25 contributions',
      'Brought the translation to 100%',
    ],
  });
  assert.equal(resume.volunteer[1].url, 'https://w/beta/');
  assert.deepEqual(resume.languages, [{ language: 'Albanian' }]);
  // schema rules: dates are ISO 8601, urls are absolute, no undefined values survive serialising
  for (const v of resume.volunteer) {
    assert.match(v.startDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(new URL(v.url));
    assert.deepEqual(JSON.parse(JSON.stringify(v)), v);
  }
  const bare = toJsonResume(
    portfolioData({ entries: [], activity: null, config: normalizeConfig({}), languageName: '' }),
  );
  assert.deepEqual(bare.volunteer, []);
  assert.equal(bare.basics.url, undefined);
  assert.equal(bare.basics.summary, 'Open-source translator: 0 strings across 0 projects.');
});
