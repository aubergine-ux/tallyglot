#!/usr/bin/env node
// tallyglot: translation progress in the terminal. See --help.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HELP, configFromFlags, parseArgs, renderJson, renderText, summarize } from '../src/cli.js';
import { instanceFingerprint, isActiveInstance, normalizeConfig } from '../src/core.js';
import { clientFor, refreshPlatform } from '../src/platforms/index.js';
import { dayKey, emptyActivity, recordChanges } from '../src/stats.js';

const here = dirname(fileURLToPath(import.meta.url));
const HOUR = 3600000;

const readJson = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
};
const fail = (message) => {
  console.error(`tallyglot: ${message}\nTry: tallyglot --help`);
  process.exit(2);
};

async function fromUrl(address) {
  let base;
  try {
    base = new URL(address.endsWith('/') ? address : `${address}/`);
  } catch {
    fail(`not an address: ${address}`);
  }
  const get = async (path) => {
    const res = await fetch(new URL(path, base), { headers: { 'User-Agent': 'tallyglot-cli' } });
    return res.ok ? res.json() : null;
  };
  const [config, snapshot, activity] = await Promise.all([
    get('tallyglot.config.json'),
    get('data/snapshot.json'),
    get('data/activity.json'),
  ]);
  if (!snapshot) throw new Error(`no Tallyglot data at ${base.href}`);
  return { config: normalizeConfig(config || {}), snapshot, activity };
}

/** Fetch from the platforms, keeping what was fetched in ~/.cache for cacheHours. */
async function live(config, { refresh }) {
  const cacheDir = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'tallyglot');
  const instances = config.instances.filter(isActiveInstance);
  const key = Buffer.from(
    JSON.stringify(instances.map((i) => instanceFingerprint(i, config.language))),
  ).toString('base64url');
  const cachePath = join(cacheDir, `${key.slice(0, 80)}.json`);
  const cached = await readJson(cachePath);
  const age = cached ? Date.now() - Date.parse(cached.snapshot.generatedAt) : Infinity;
  if (cached && !refresh && age < config.cacheHours * HOUR) return cached;

  let tokens = {};
  try {
    tokens = JSON.parse(process.env.TALLYGLOT_TOKENS || process.env.WEBLATE_TOKENS || '{}');
  } catch {
    console.error('tallyglot: TALLYGLOT_TOKENS is not valid JSON; continuing without tokens');
  }
  const now = Date.now();
  const snapshot = {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    language: { code: config.language, name: config.languageName },
    instances: {},
  };
  const activity = cached?.activity || emptyActivity();
  for (const instance of instances) {
    const before = cached?.snapshot.instances[instance.id];
    const client = clientFor(instance, {
      token: tokens[instance.id],
      headers: { 'User-Agent': 'tallyglot-cli' },
    });
    let result;
    try {
      result = await refreshPlatform(client, instance, {
        language: config.language,
        known: before?.known,
        previous: before?.entries || [],
        discoveryPages: config.discoveryPages,
        now,
        onChanges: (user, changes) => recordChanges(activity, instance.id, user, changes),
      });
    } catch (err) {
      result = { entries: before?.entries || [], known: before?.known, errors: [err.message] };
    }
    const notes = [...result.errors];
    if (result.limited) notes.push('rate limit reached; showing what was saved');
    snapshot.instances[instance.id] = {
      name: instance.name,
      entries: result.entries,
      known: result.known,
      errors: notes,
    };
  }
  const entries = Object.values(snapshot.instances).flatMap((i) => i.entries);
  snapshot.language.name ||= entries.find((e) => e.language?.name)?.language.name || '';
  const fresh = { snapshot, activity };
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cachePath, JSON.stringify(fresh));
  } catch {
    // a read-only home directory only costs the cache
  }
  return fresh;
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.error) fail(parsed.error);
const { options } = parsed;

if (options.help) {
  console.log(HELP);
} else if (options.version) {
  console.log(JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8')).version);
} else {
  try {
    let config;
    let data;
    if (options.url) {
      ({ config, ...data } = await fromUrl(options.url));
    } else {
      const configPath = resolve(options.config || 'tallyglot.config.json');
      const raw = options.lang ? configFromFlags(options) : await readJson(configPath);
      if (!raw) {
        fail(
          options.config
            ? `cannot read ${configPath}`
            : 'no tallyglot.config.json here. Use --url, --lang with --user, or --config.',
        );
      }
      config = normalizeConfig(raw);
      if (!config.language) fail('the configuration has no language');
      const dir = dirname(configPath);
      const saved =
        options.lang || options.refresh ? null : await readJson(join(dir, 'data', 'snapshot.json'));
      data = saved
        ? { snapshot: saved, activity: await readJson(join(dir, 'data', 'activity.json')) }
        : await live(config, options);
    }
    const summary = summarize({ ...data, staleDays: config.staleDays, today: dayKey(Date.now()) });
    const color = !options.noColor && !process.env.NO_COLOR && process.stdout.isTTY === true;
    process.stdout.write(
      options.json
        ? renderJson(summary)
        : `${renderText(summary, { color, limit: options.limit ?? 15, width: process.stdout.columns || 80 })}\n`,
    );
    if (!summary.components) process.exitCode = 1;
  } catch (err) {
    console.error(`tallyglot: ${err.message}`);
    process.exitCode = 1;
  }
}
