#!/usr/bin/env node
// Configure a fork: writes tallyglot.config.json, then (optionally) commits,
// pushes, turns on GitHub Pages and starts the badge workflow.
//
//   node scripts/setup.mjs                      interactive
//   node scripts/setup.mjs --lang sq --user alice --instances hosted,fedora --yes

import { execFileSync } from 'node:child_process';
import { readFile, rm, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { normalizeBaseUrl } from '../src/api.js';
import { PRESETS } from '../src/presets.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
};
const yes = flag('yes') === true;
const rl = createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();
// Reads one line at a time, so answers can also be piped in.
const ask = async (question, fallback = '') => {
  if (yes) return fallback;
  process.stdout.write(`${question}${fallback ? ` [${fallback}]` : ''}: `);
  const { value, done } = await lines.next();
  if (done) process.stdout.write('\n');
  return (value || '').trim() || fallback;
};
const split = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const run = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();
const tryRun = (...a) => {
  try {
    return run(...a);
  } catch {
    return null;
  }
};

console.log('\nTallyglot setup\n');

const language = await ask(
  'Language code (as used in Weblate URLs, e.g. sq, pt_BR)',
  flag('lang') || '',
);
if (!language) {
  console.error('A language code is required.');
  process.exit(1);
}
const usernames = split(await ask('Your Weblate username(s), comma separated', flag('user') || ''));

console.log(`\nKnown instances: ${PRESETS.map((p) => `${p.id} (${p.name})`).join(', ')}`);
const chosen = split(
  await ask(
    'Instances to track: ids from the list and/or full URLs',
    flag('instances') || 'hosted',
  ),
);
const instances = [];
for (const item of chosen) {
  const preset = PRESETS.find((p) => p.id === item.toLowerCase());
  const entry = preset ? { id: preset.id } : { url: normalizeBaseUrl(item) };
  const label = preset ? preset.name : entry.url;
  const own = split(await ask(`  Username on ${label}, if different`, ''));
  if (own.length) entry.usernames = own;
  const pinned = split(
    await ask(
      `  Projects to always show on ${label} (project or project/component)`,
      flag('pin') && chosen.length === 1 ? flag('pin') : '',
    ),
  );
  entry.pinned = pinned;
  instances.push(entry);
}

const configPath = join(root, 'tallyglot.config.json');
let previous = {};
try {
  previous = JSON.parse(await readFile(configPath, 'utf8'));
} catch {}
const config = {
  language,
  usernames,
  instances,
  staleDays: previous.staleDays ?? 30,
  cacheHours: previous.cacheHours ?? 12,
};
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log('\n✓ Wrote tallyglot.config.json');

// Data and badges from the repository this was forked from no longer apply.
await rm(join(root, 'data', 'snapshot.json'), { force: true });
for (const file of await readdir(join(root, 'badges')).catch(() => [])) {
  if (file.endsWith('.svg')) await rm(join(root, 'badges', file));
}

const repo = tryRun('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
if (!repo) {
  console.log(
    '\nNext: commit and push, enable GitHub Pages (Settings → Pages → Deploy from branch → main),\n' +
      'then run the "Update badges" workflow from the Actions tab.',
  );
  rl.close();
  process.exit(0);
}

const go = (
  await ask(`\nCommit, push and publish ${repo} on GitHub Pages now? (y/n)`, 'y')
).toLowerCase();
rl.close();
if (!go.startsWith('y')) process.exit(0);

const step = (label, fn) => {
  try {
    fn();
    console.log(`✓ ${label}`);
  } catch (err) {
    console.log(
      `! ${label} failed: ${(err.stderr || err.message || '').toString().trim().split('\n')[0]}`,
    );
  }
};
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
step('Committed and pushed the config', () => {
  run('git', ['add', '-A', 'tallyglot.config.json', 'data', 'badges']);
  if (tryRun('git', ['diff', '--cached', '--quiet']) === null) {
    run('git', ['commit', '-m', `Configure Tallyglot for ${language}`]);
  }
  run('git', ['push', '-u', 'origin', branch]);
});
step('Enabled GitHub Pages', () => {
  if (tryRun('gh', ['api', `repos/${repo}/pages`]) === null) {
    run('gh', [
      'api',
      '-X',
      'POST',
      `repos/${repo}/pages`,
      '-f',
      `source[branch]=${branch}`,
      '-f',
      'source[path]=/',
    ]);
  }
});
step('Enabled the badge workflow', () => {
  tryRun('gh', ['api', '-X', 'PUT', `repos/${repo}/actions/permissions`, '-F', 'enabled=true']);
  run('gh', ['workflow', 'enable', 'badges.yml']);
});
step('Started the first badge run', () =>
  run('gh', ['workflow', 'run', 'badges.yml', '--ref', branch]),
);

const [owner, name] = repo.split('/');
// Ask GitHub for the address: accounts with a custom domain don't use github.io.
const site = (
  tryRun('gh', ['api', `repos/${repo}/pages`, '--jq', '.html_url']) ||
  `https://${owner.toLowerCase()}.github.io/${name}/`
).replace(/^http:/, 'https:');
console.log(`
Your dashboard: ${site}   (first deploy takes a minute or two)
Profile badge:  [![${language} translation progress](${site}badges/overall.svg)](${site})
`);
