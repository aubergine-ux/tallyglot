import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';

import {
  buildTerms,
  collectTerms,
  dropGlossaryInstance,
  emptyGlossary,
  exportPairs,
  isTerm,
  normalizeTerm,
  toCsv,
  toTbx,
} from '../src/glossary.js';
import { CONFIG, NOW, fixture, repo, routes, run } from './helpers.mjs';

let nextId = 1;
const change = (source, target, project = 'alpha', extra = {}) => ({
  unit: `https://w.test/api/units/${extra.id ?? nextId++}/`,
  translation: `https://w.test/api/translations/${project}/app/sq/`,
  timestamp: extra.at || '2026-05-01T10:00:00Z',
  target,
  details: { source },
});

test('isTerm: short human text only', () => {
  for (const yes of [
    'Settings',
    'Dark theme',
    'Sign in…',
    '&File',
    'Përditësim',
    'Save as new file',
    '设置',
  ]) {
    assert.equal(isTerm(yes), true, yes);
  }
  for (const no of [
    '',
    '   ',
    null,
    undefined,
    '42',
    '…',
    'This sentence has five words',
    'x'.repeat(41),
    'Hello %s',
    '{count} files',
    'Open <b>file</b>',
    'One\nTwo',
    'Cat\x1eCats',
  ]) {
    assert.equal(isTerm(no), false, JSON.stringify(no));
  }
});

test('normalizeTerm: case, accelerators, punctuation and spacing do not make a new term', () => {
  const same = [
    'Settings',
    'settings',
    'SETTINGS',
    ' Settings ',
    'Settings…',
    'Settings:',
    '&Settings',
    'S_ettings',
    '"Settings"',
    'Settings...',
    '«Settings»',
  ];
  assert.deepEqual([...new Set(same.map(normalizeTerm))], ['settings']);
  assert.equal(normalizeTerm('Sign   in'), 'sign in');
  assert.equal(normalizeTerm('Save & close'), 'save & close'); // "&" between words is not an accelerator
  assert.equal(normalizeTerm('é'), 'é'); // composed and decomposed forms match
  assert.notEqual(normalizeTerm('Setting'), normalizeTerm('Settings'));
  assert.equal(normalizeTerm('…'), '');
  assert.equal(normalizeTerm(null), '');
});

test('matching: variants are grouped across projects, inconsistent terms first', () => {
  const g = emptyGlossary();
  collectTerms(g, 'hosted', [
    change('Settings', 'Cilësimet', 'alpha'),
    change('settings…', 'Cilësimet', 'beta'),
    change('SETTINGS', 'cilësimet.', 'beta'), // same translation, different dress
    change('&Settings', 'Rregullimet', 'gamma'),
    change('Settings:', 'Parametrat:', 'delta'),
    change('Save', 'Ruaj', 'alpha'),
    change('Save', 'Ruaj', 'beta'),
    change('Close', 'Mbyll', 'alpha'),
    change('A whole sentence that is not a term at all', 'x', 'alpha'),
    change('Empty', '', 'alpha'),
    change('Plural', 'a\x1eb', 'alpha'),
    {
      unit: null,
      translation: 'https://w.test/api/translations/a/b/sq/',
      target: 'x',
      details: { source: 'No unit' },
    },
    {
      unit: 'https://w.test/api/units/999/',
      translation: null,
      target: 'x',
      details: { source: 'No translation' },
    },
    {
      unit: 'https://w.test/api/units/998/',
      translation: 'https://w.test/api/translations/a/b/sq/',
      target: 'x',
    },
  ]);
  assert.equal(Object.keys(g.units).length, 8);
  const terms = buildTerms(g);
  assert.deepEqual(
    terms.map((t) => [t.term, t.consistent, t.variants.length]),
    [
      ['Settings', false, 3],
      ['Save', true, 1],
      ['Close', true, 1],
    ],
  );
  const [settings] = terms;
  assert.deepEqual(
    settings.variants.map((v) => [v.target, v.count, v.projects]),
    [
      ['Cilësimet', 3, ['hosted:alpha', 'hosted:beta']],
      ['Parametrat:', 1, ['hosted:delta']],
      ['Rregullimet', 1, ['hosted:gamma']],
    ],
  );
  assert.equal(settings.variants[0].units.length, 3);
  assert.equal(settings.variants[0].units[0].path, 'alpha/app');
  assert.equal(settings.uses, 5);
  assert.equal(settings.preferred, null);
});

test('matching: a string translated again replaces its older translation', () => {
  const g = emptyGlossary();
  collectTerms(g, 'hosted', [
    change('Save', 'Ruaje', 'alpha', { id: 5, at: '2026-01-01T00:00:00Z' }),
  ]);
  collectTerms(g, 'hosted', [
    change('Save', 'Ruaj', 'alpha', { id: 5, at: '2026-03-01T00:00:00Z' }),
  ]);
  collectTerms(g, 'hosted', [
    change('Save', 'Old', 'alpha', { id: 5, at: '2025-01-01T00:00:00Z' }),
  ]); // older page of history
  assert.deepEqual(Object.values(g.units), [
    ['Save', 'Ruaj', 'alpha/app', '2026-03-01T00:00:00.000Z'],
  ]);
  assert.equal(buildTerms(g)[0].consistent, true);
  // the same unit id on another instance is another string
  collectTerms(g, 'codeberg', [change('Save', 'Ruaje', 'alpha', { id: 5 })]);
  assert.equal(buildTerms(g)[0].consistent, false);
  dropGlossaryInstance(g, 'codeberg');
  assert.deepEqual(Object.keys(g.units), ['hosted:5']);
});

test('matching: a preferred translation must be one of the variants', () => {
  const g = emptyGlossary();
  collectTerms(g, 'hosted', [change('Save', 'Ruaj'), change('Save', 'Ruaje', 'beta')]);
  assert.equal(buildTerms(g, { save: 'Ruaje' })[0].preferred, 'Ruaje');
  assert.equal(buildTerms(g, { save: 'Gone' })[0].preferred, null);
  assert.deepEqual(buildTerms(null), []);
  assert.deepEqual(buildTerms({}), []);
});

test('matching: thousands of strings stay fast and bounded', () => {
  const g = emptyGlossary();
  const many = Array.from({ length: 12000 }, (_, i) =>
    change(`Term ${i % 3000}`, `T${i % 7}`, `p${i % 40}`, {
      id: 100000 + i,
      at: new Date(NOW - i * 60000).toISOString(),
    }),
  );
  const start = performance.now();
  collectTerms(g, 'hosted', many);
  const terms = buildTerms(g);
  assert.ok(performance.now() - start < 2000);
  assert.equal(Object.keys(g.units).length, 8000); // the oldest are dropped
  assert.ok(g.units['hosted:100000'] && !g.units['hosted:111999']);
  assert.equal(terms.length, 3000);
});

test('export: preferred, then only, then most used; strict leaves the undecided out', () => {
  const g = emptyGlossary();
  collectTerms(g, 'hosted', [
    change('Save', 'Ruaj'),
    change('Save', 'Ruaj', 'b'),
    change('Save', 'Ruaje', 'c'),
    change('Close', 'Mbyll'),
    change('Search', 'Kërko'),
    change('Search', 'Kërkim', 'b'),
  ]);
  const terms = buildTerms(g, { search: 'Kërkim' });
  assert.deepEqual(exportPairs(terms), [
    { source: 'Close', target: 'Mbyll' },
    { source: 'Save', target: 'Ruaj' },
    { source: 'Search', target: 'Kërkim' },
  ]);
  assert.deepEqual(
    exportPairs(terms, { strict: true }).map((p) => p.source),
    ['Close', 'Search'],
  );
  assert.deepEqual(exportPairs([]), []);
});

test('export: CSV quoting, and no spreadsheet formulas', () => {
  const csv = toCsv([
    { source: 'Save', target: 'Ruaj' },
    { source: 'Yes, please', target: 'Po, "faleminderit"' },
    { source: '=cmd|x', target: '+1' },
    { source: 'Line', target: 'a\nb' },
  ]);
  assert.equal(
    csv,
    'source,target\r\nSave,Ruaj\r\n"Yes, please","Po, ""faleminderit"""\r\n\'=cmd|x,\'+1\r\nLine,"a\nb"\r\n',
  );
  assert.equal(toCsv([]), 'source,target\r\n');
});

test('export: TBX is well formed and escaped', () => {
  const tbx = toTbx([{ source: 'Cut & paste', target: '<Prij> "e" ngjit' }], {
    language: 'pt_BR',
    title: 'A & B',
  });
  assert.match(tbx, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE martif/);
  assert.ok(tbx.includes('<title>A &amp; B</title>'));
  assert.ok(
    tbx.includes('<langSet xml:lang="en"><tig><term>Cut &amp; paste</term></tig></langSet>'),
  );
  assert.ok(
    tbx.includes(
      '<langSet xml:lang="pt-BR"><tig><term>&lt;Prij&gt; &quot;e&quot; ngjit</term></tig></langSet>',
    ),
  );
  // every tag that opens also closes, in order
  const stack = [];
  for (const [, close, name, selfClosing] of tbx.matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)) {
    if (selfClosing) continue;
    if (close) assert.equal(stack.pop(), name);
    else stack.push(name);
  }
  assert.deepEqual(stack, []);
  assert.equal(toTbx([], { language: 'sq' }).match(/<termEntry/g), null);
});

test('data source: a recorded Weblate change yields a term', () => {
  const g = emptyGlossary();
  const changes = fixture('weblate-changes').results;
  changes[0].details.source = 'Star us';
  collectTerms(g, 'hosted', changes);
  const unit = Object.entries(g.units).find(([, u]) => u[0] === 'Star us');
  assert.match(unit[0], /^hosted:\d+$/);
  assert.deepEqual(unit[1].slice(0, 3), [
    'Star us',
    'Na mbështet me një yll.',
    'trale/localizations',
  ]);
});

test('build: the glossary is written by the Action and survives later runs', async () => {
  const changes = structuredClone(fixture('weblate-changes'));
  changes.results[0].details.source = 'Star us';
  changes.results[1].details.source = 'Star us!';
  changes.results[1].target = 'Jepi një yll';
  changes.next = null;
  const withTerms = routes([
    [
      '/api/changes/',
      (url) => (url.searchParams.get('timestamp_after') ? { results: [], next: null } : changes),
    ],
  ]);
  const r = await repo(CONFIG);
  try {
    await run(r, { routes: withTerms });
    let glossary = await r.read('data/glossary.json');
    assert.equal(Object.keys(glossary.units).length, 2);
    assert.equal(buildTerms(glossary)[0].consistent, false);
    await run(r, { routes: withTerms, now: NOW + 86400000 });
    glossary = await r.read('data/glossary.json');
    assert.equal(Object.keys(glossary.units).length, 2);
    assert.ok(glossary.sources.hosted);
  } finally {
    await rm(r.root, { recursive: true });
  }
});
