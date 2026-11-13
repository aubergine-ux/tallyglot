import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  cellWidth,
  configFromFlags,
  parseArgs,
  renderJson,
  renderText,
  summarize,
} from '../src/cli.js';
import { CONFIG, repo, run as build } from './helpers.mjs';

const bin = fileURLToPath(new URL('../bin/tallyglot.mjs', import.meta.url));
const cli = (args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { ...opts, env: { ...process.env, NO_COLOR: '', ...opts.env } },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });

const entry = (instance, project, total, translated, extra = {}) => ({
  id: `${instance}:${project}/c`,
  instance,
  project: { slug: project, name: extra.name || project, url: `https://w/${project}/` },
  component: { slug: 'c', name: 'c' },
  total,
  translated,
  fuzzy: 0,
  untranslated: total - translated,
  lastChange: '2026-11-10T00:00:00.000Z',
});
const snapshot = {
  generatedAt: '2026-11-12T09:23:09.728Z',
  language: { code: 'sq', name: 'Albanian' },
  instances: {
    hosted: {
      name: 'Hosted Weblate',
      entries: [
        entry('hosted', 'alpha', 200, 200),
        entry('hosted', 'beta', 1000, 400),
        entry('hosted', 'gamma', 50, 49, { name: '日本語プロジェクト' }),
      ],
      errors: ['rate limit reached'],
    },
  },
};
const activity = {
  days: { '2026-11-11': { 'hosted:alpha': 3 }, '2026-11-12': { 'hosted:alpha': 4 } },
};

test('cli: arguments', () => {
  assert.deepEqual(parseArgs([]), { options: {} });
  assert.deepEqual(parseArgs(['--json', '--limit', '3', '--url=https://x/y/', '-h']).options, {
    json: true,
    limit: 3,
    url: 'https://x/y/',
    help: true,
  });
  assert.deepEqual(parseArgs(['--no-color', '-v']).options, { noColor: true, version: true });
  assert.deepEqual(parseArgs(['--lang', 'sq', '--user', 'a,b']).options, {
    lang: 'sq',
    user: 'a,b',
  });
  for (const [argv, message] of [
    [['--nope'], /Unknown option: --nope/],
    [['extra'], /Unknown option: extra/],
    [['-x'], /Unknown option/],
    [['--lang'], /--lang needs a value/],
    [['--lang', '--json'], /--lang needs a value/],
    [['--limit', 'many'], /whole number/],
    [['--limit', '-1'], /whole number|needs a value/],
    [['--json=yes'], /takes no value/],
    [['--url', 'https://x/', '--lang', 'sq'], /cannot be combined/],
  ]) {
    assert.match(parseArgs(argv).error, message, argv.join(' '));
  }
  assert.deepEqual(
    configFromFlags({ lang: 'sq', user: 'a, b', instance: 'hosted,weblate.example.org' }),
    {
      language: 'sq',
      usernames: ['a', 'b'],
      instances: [{ id: 'hosted' }, { url: 'weblate.example.org' }],
    },
  );
  assert.deepEqual(configFromFlags({ lang: 'sq' }).instances, [{ id: 'hosted' }]);
});

test('cli: summary numbers and order', () => {
  const s = summarize({ snapshot, activity, staleDays: 30, today: '2026-11-12' });
  assert.deepEqual(
    [s.percent, s.total, s.translated, s.left, s.projects, s.complete],
    [51.9, 1250, 649, 601, 3, 1],
  );
  assert.deepEqual([s.contributions, s.streak, s.longestStreak], [7, 2, 2]);
  assert.deepEqual(
    s.projectList.map((p) => p.name),
    ['日本語プロジェクト', 'beta', 'alpha'],
  ); // finished last
  assert.deepEqual(s.errors, ['Hosted Weblate: rate limit reached']);
  const bare = summarize({ snapshot: null, activity: null });
  assert.deepEqual(
    [bare.components, bare.contributions, bare.streak, bare.projectList],
    [0, null, null, []],
  );
});

test('cli: text output lines up, with or without colour, in any script', () => {
  const s = summarize({ snapshot, activity, today: '2026-11-12' });
  const plain = renderText(s, { width: 80 });
  assert.ok(!plain.includes('\x1b['));
  assert.match(plain, /Tallyglot {2}Albanian \(sq\)/);
  assert.match(plain, /649 of 1,250 strings · 3 projects · 1 complete · 601 left/);
  assert.match(plain, /2-day streak · longest 2 · 7 contributions/);
  assert.match(plain, /alpha .* 100% {2}✓ done/);
  assert.match(plain, /! Hosted Weblate: rate limit reached/);
  assert.match(plain, /Numbers from 2026-11-12 09:23 UTC/);
  const rows = plain.split('\n').filter((l) => /left$|done$/.test(l) && l.includes('█'));
  assert.equal(rows.length, 3);
  // every bar starts in the same column, although one name is in double-width characters
  assert.equal(new Set(rows.map((r) => cellWidth(r.slice(0, r.search(/[█░]/))))).size, 1);
  for (const line of plain.split('\n')) assert.ok(cellWidth(line) <= 80, line);
  const coloured = renderText(s, { color: true });
  assert.ok(coloured.includes('\x1b[32m') && coloured.includes('\x1b[0m'));
  assert.equal(coloured.replace(/\x1b\[[\d;]*m/g, ''), plain);
  assert.match(renderText(s, { limit: 1 }), /… and 2 more \(--limit 0 shows all\)/);
  assert.ok(!renderText(s, { limit: 0 }).includes('more ('));
  assert.match(renderText(summarize({ snapshot: null })), /No translations found/);
  // narrow terminals and very long names do not break the layout
  const long = structuredClone(snapshot);
  long.instances.hosted.entries[0].project.name =
    'A project with a remarkably long name that goes on';
  const narrow = renderText(summarize({ snapshot: long }), { width: 20 });
  assert.match(narrow, /A project with a remarkably…/);
  assert.equal(cellWidth('日本語'), 6);
  assert.equal(cellWidth('é'), 1);
});

test('cli: JSON output is stable and complete', () => {
  const json = JSON.parse(renderJson(summarize({ snapshot, activity, today: '2026-11-12' })));
  assert.deepEqual(Object.keys(json), [
    'language',
    'generatedAt',
    'percent',
    'total',
    'translated',
    'left',
    'projects',
    'components',
    'complete',
    'stale',
    'contributions',
    'streak',
    'longestStreak',
    'errors',
    'projectList',
  ]);
  assert.deepEqual(Object.keys(json.projectList[0]), [
    'name',
    'instance',
    'platform',
    'percent',
    'total',
    'translated',
    'left',
    'components',
    'complete',
    'url',
  ]);
});

test('cli: runs in a repository the Action has written to', async () => {
  const r = await repo(CONFIG);
  try {
    await build(r);
    const text = await cli([], { cwd: r.root });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /Albanian \(sq\)/);
    assert.match(text.stdout, /4 projects/);
    assert.ok(!text.stdout.includes('\x1b['), 'no colour when piped');
    const json = await cli(['--json', '--config', join(r.root, 'tallyglot.config.json')]);
    assert.equal(JSON.parse(json.stdout).projects, 4);
    assert.equal(JSON.parse(json.stdout).contributions, 2);
  } finally {
    await rm(r.root, { recursive: true });
  }
});

test('cli: reads a published dashboard with --url', async () => {
  const files = {
    '/t/data/snapshot.json': snapshot,
    '/t/data/activity.json': activity,
    '/t/tallyglot.config.json': { language: 'sq' },
  };
  const server = createServer((req, res) => {
    const body = files[req.url];
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(body ? JSON.stringify(body) : '');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await cli(['--url', `${base}/t`, '--json']); // no trailing slash needed
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(
      [JSON.parse(ok.stdout).percent, JSON.parse(ok.stdout).streak !== null],
      [51.9, true],
    );
    const missing = await cli(['--url', `${base}/nothing/`]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /no Tallyglot data at/);
    const bad = await cli(['--url', 'not a url']);
    assert.equal(bad.code, 2);
  } finally {
    server.close();
  }
});

test('cli: help, version, and helpful failures', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'tallyglot-cli-'));
  try {
    const help = await cli(['--help']);
    assert.match(help.stdout, /^Usage: tallyglot \[options\]/);
    for (const flag of [
      '--url',
      '--config',
      '--lang',
      '--user',
      '--instance',
      '--refresh',
      '--json',
      '--limit',
      '--no-color',
    ]) {
      assert.ok(help.stdout.includes(flag), flag);
    }
    assert.match((await cli(['-v'])).stdout, /^\d+\.\d+\.\d+\n$/);
    const none = await cli([], { cwd: empty });
    assert.equal(none.code, 2);
    assert.match(none.stderr, /no tallyglot\.config\.json here/);
    const missing = await cli(['--config', join(empty, 'nope.json')]);
    assert.match(missing.stderr, /cannot read .*nope\.json/);
    const unknown = await cli(['--frobnicate']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /Unknown option: --frobnicate\nTry: tallyglot --help/);
  } finally {
    await rm(empty, { recursive: true });
  }
});
