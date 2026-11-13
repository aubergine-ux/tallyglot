import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { matchLocale, setLocale, t, tt } from '../src/i18n.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const english = JSON.parse(readFileSync(join(root, 'locales/en.json'), 'utf8'));

const flatten = (node, prefix = '') =>
  Object.entries(node).flatMap(([k, v]) =>
    typeof v === 'string' ? [`${prefix}${k}`] : flatten(v, `${prefix}${k}.`),
  );
const sources = (dir) =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((f) =>
    f.isDirectory()
      ? sources(join(dir, f.name))
      : f.name.endsWith('.js')
        ? [join(dir, f.name)]
        : [],
  );

test('i18n: every string the code asks for exists, and none is left over', () => {
  const keys = new Set(flatten(english));
  const base = (k) => k.replace(/_(zero|one|two|few|many|other)$/, '');
  const known = new Set([...keys].map(base));
  const used = new Set();
  const prefixes = new Set();
  for (const file of sources('src')) {
    const code = readFileSync(join(root, file), 'utf8');
    for (const [, key] of code.matchAll(/\btt?\(\s*'([\w.]+)'/g)) {
      assert.ok(known.has(key), `${file} uses "${key}", which is not in locales/en.json`);
      used.add(key);
    }
    // t(`nav.${view}`), t(cond ? 'a.b' : 'a.c')
    for (const [, prefix] of code.matchAll(/\btt?\(\s*`([\w.]+)\$\{/g)) prefixes.add(prefix);
    for (const [, inner] of code.matchAll(/\btt?\(\s*([^,)]*\?[^,)]*)[,)]/g)) {
      for (const [, key] of inner.matchAll(/'([\w]+\.[\w.]+)'/g)) {
        assert.ok(known.has(key), `${file} uses "${key}", which is not in locales/en.json`);
        used.add(key);
      }
    }
  }
  const unused = [...known].filter(
    (k) => !used.has(k) && ![...prefixes].some((p) => k.startsWith(p)),
  );
  assert.deepEqual(unused, [], 'strings in locales/en.json that nothing uses');
});

test('i18n: plural keys come in pairs and placeholders are well formed', () => {
  const keys = flatten(english);
  for (const key of keys) {
    if (key.endsWith('_one')) assert.ok(keys.includes(key.replace(/_one$/, '_other')), key);
    const value = key.split('.').reduce((n, part) => n[part], english);
    // every {{ opens a well-formed {{name}}
    assert.ok(!/\{\{(?!\s*\w+\s*\}\})/.test(value), key);
  }
});

test('i18n: every listed locale has a file that parses', () => {
  const index = JSON.parse(readFileSync(join(root, 'locales/index.json'), 'utf8'));
  assert.equal(index.en, 'English');
  for (const code of Object.keys(index)) {
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(root, `locales/${code}.json`), 'utf8')));
  }
});

test('i18n: interpolation, escaping, plurals and fallback', () => {
  setLocale('en', english, english);
  assert.equal(t('count.projects', { count: 1 }), '1 project');
  assert.equal(t('count.projects', { count: 2400 }), '2,400 projects');
  assert.equal(
    t('hero.updated', { when: '<b>now</b>' }),
    'Last updated &#60;b&#62;now&#60;/b&#62;',
  );
  assert.equal(tt('hero.updated', { when: '<b>now</b>' }), 'Last updated <b>now</b>');
  assert.equal(
    t('hero.caption', { projects: { html: '<i>2</i>' }, components: 'x' }),
    'translated across <i>2</i> and x',
  );
  assert.equal(t('no.such.key'), 'no.such.key');
  assert.equal(t('hero.updated'), 'Last updated ');

  // A partial translation falls back to English key by key; plural rules follow the locale.
  setLocale(
    'pl',
    {
      count: {
        projects_one: '{{count}} projekt',
        projects_few: '{{count}} projekty',
        projects_many: '{{count}} projektów',
      },
    },
    english,
  );
  assert.equal(t('count.projects', { count: 1 }), '1 projekt');
  assert.equal(t('count.projects', { count: 3 }), '3 projekty');
  assert.equal(t('count.projects', { count: 5 }), '5 projektów');
  assert.equal(t('count.components', { count: 5 }), '5 components');
  assert.equal(t('shell.refresh'), 'Refresh');
  setLocale('xx-not-a-locale!', {}, english); // must not throw
  assert.equal(t('shell.refresh'), 'Refresh');
  setLocale('en', english, english);
});

test('i18n: locale matching', () => {
  const have = { en: 'English', sq: 'Shqip', pt_BR: 'Português (Brasil)' };
  assert.equal(matchLocale(have, ['sq-AL', 'en']), 'sq');
  assert.equal(matchLocale(have, [null, undefined, 'pt-br']), 'pt_BR');
  assert.equal(matchLocale(have, ['de', 'fr']), 'en');
  assert.equal(matchLocale(have, []), 'en');
});
