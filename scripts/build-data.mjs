#!/usr/bin/env node
// Fetches translation stats for everything in tallyglot.config.json and writes
//   data/snapshot.json   – what the web app shows before (or instead of) live data
//   badges/*.svg         – static badges for READMEs
// Run by .github/workflows/badges.yml; also works locally: node scripts/build-data.mjs
//
// Optional API tokens (raise the limit from 100 requests/day to 5000/hour):
//   WEBLATE_TOKENS='{"hosted":"wlu_…","fedora":"wlu_…"}'   keyed by instance id

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WeblateClient } from '../src/api.js';
import { badgeFileName, overallBadge, projectBadge } from '../src/badge.js';
import {
  aggregate,
  groupByProject,
  instanceFingerprint,
  normalizeConfig,
  refreshInstance,
} from '../src/core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (path, fallback) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (fallback !== undefined && err.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read ${path}: ${err.message}`);
  }
};

function readTokens() {
  const raw = process.env.WEBLATE_TOKENS;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    console.warn('! WEBLATE_TOKENS is not valid JSON; continuing without tokens');
    return {};
  }
}

async function main() {
  const config = normalizeConfig(await readJson(join(root, 'tallyglot.config.json')));
  if (!config.language) throw new Error('tallyglot.config.json: "language" is required');

  const snapshotPath = join(root, 'data', 'snapshot.json');
  const old = await readJson(snapshotPath, { instances: {} });
  const tokens = readTokens();
  const now = Date.now();

  const snapshot = {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    language: { code: config.language, name: config.languageName },
    instances: {},
  };
  let failed = 0;

  for (const instance of config.instances.filter((i) => i.enabled)) {
    const fingerprint = instanceFingerprint(instance, config.language);
    const before = old.instances?.[instance.id];
    const reusable = before && before.fingerprint === fingerprint;
    const client = new WeblateClient({
      baseUrl: instance.url,
      token: tokens[instance.id],
      headers: { 'User-Agent': 'tallyglot' },
    });

    process.stdout.write(`${instance.name}: `);
    let result;
    try {
      result = await refreshInstance(client, instance, {
        language: config.language,
        known: reusable ? before.known : undefined,
        previous: reusable ? before.entries : [],
        discoveryPages: config.discoveryPages,
        now,
      });
    } catch (err) {
      result = {
        entries: reusable ? before.entries : [],
        known: reusable ? before.known : undefined,
        errors: [err.message],
        limited: false,
        unreachable: true,
        fetched: 0,
        pending: 0,
      };
    }

    const notes = [...result.errors];
    if (result.limited) {
      notes.push(
        `rate limit reached, ${result.pending} component(s) kept from the previous run` +
          (tokens[instance.id] ? '' : ' (add a token to WEBLATE_TOKENS to avoid this)'),
      );
    }
    if (result.moreHistory) {
      notes.push('older contribution history is still being read; more components may appear on the next run');
    }
    if (result.limited || result.unreachable) failed += 1;
    console.log(
      `${result.entries.length} component(s), ${result.fetched} refreshed, ${client.requests} request(s)` +
        (client.rate.remaining !== null ? `, ${client.rate.remaining} left in quota` : ''),
    );
    notes.forEach((n) => console.log(`  ! ${n}`));

    snapshot.instances[instance.id] = {
      name: instance.name,
      url: instance.url,
      fingerprint,
      updatedAt: result.fetched || !before ? snapshot.generatedAt : before.updatedAt,
      entries: result.entries.sort((a, b) => a.id.localeCompare(b.id)),
      known: result.known,
      errors: notes,
    };
  }

  const entries = Object.values(snapshot.instances).flatMap((i) => i.entries);
  snapshot.language.name ||= entries.find((e) => e.language.name)?.language.name || config.language;
  const stats = aggregate(entries, { staleDays: config.staleDays, now });

  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 1)}\n`);

  const badgeDir = join(root, 'badges');
  await mkdir(badgeDir, { recursive: true });
  const wanted = new Map();
  wanted.set('overall.svg', overallBadge({ label: config.badgeLabel || snapshot.language.name, stats }));
  for (const group of groupByProject(entries)) {
    wanted.set(badgeFileName(group), projectBadge({ group, languageCode: config.language }));
  }
  for (const file of await readdir(badgeDir)) {
    if (file.endsWith('.svg') && !wanted.has(file)) await rm(join(badgeDir, file));
  }
  for (const [file, svg] of wanted) await writeFile(join(badgeDir, file), svg);

  console.log(
    `\n${snapshot.language.name}: ${stats.percent}% across ${stats.projects} project(s), ` +
      `${stats.components} component(s). Wrote data/snapshot.json and ${wanted.size} badge(s).`,
  );
  if (failed && !entries.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
