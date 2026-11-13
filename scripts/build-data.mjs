#!/usr/bin/env node
// Fetches translation stats for everything in tallyglot.config.json and writes
//   data/snapshot.json   – what the web app shows before (or instead of) live data
//   data/activity.json   – contributions per day, for the calendar and streaks
//   data/history/<year>.json – where every project stood on each day
//   badges/*.svg         – static badges for READMEs
//   cards/*.svg          – profile cards, one per theme
//   maintainer/*.svg, data/maintainer/*.json – coverage of the projects listed
//                          under "maintainer", for their READMEs
//   data/glossary.json   – short strings and how they were translated
//   data/findwork.json   – projects that need this language, for "Find work"
//   data/alerts.json, feed.xml – projects that gained strings to translate
// and, when configured, posts those alerts to a webhook or opens an issue:
//   ALERT_WEBHOOK_URL    Discord or Slack incoming webhook
//   GITHUB_TOKEN + GITHUB_REPOSITORY   set by Actions; used for the issue
//   SITE_URL             address of the dashboard, for links (optional)
// Run by .github/workflows/badges.yml; also works locally: node scripts/build-data.mjs
//
// API tokens, keyed by instance id. Optional for Weblate (they raise the limit
// from 100 requests/day to 5000/hour), required for Crowdin, Transifex, Lokalise:
//   TALLYGLOT_TOKENS='{"hosted":"wlu_…","crowdin":"…"}'
// WEBLATE_TOKENS, the 1.0 name of the same variable, still works.

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { badgeFileName, overallBadge, projectBadge } from '../src/badge.js';
import {
  aggregate,
  groupByProject,
  instanceFingerprint,
  isActiveInstance,
  normalizeConfig,
} from '../src/core.js';
import {
  appendEvents,
  buildMessages,
  detectNewStrings,
  issuePayload,
  renderRss,
  routeEvents,
  webhookPayload,
} from '../src/alerts.js';
import { CARD_THEMES, cardData, renderCard } from '../src/card.js';
import { emptyIndex, fillStars, pruneIndex, scanInstance } from '../src/findwork.js';
import { collectTerms, dropGlossaryInstance, emptyGlossary } from '../src/glossary.js';
import { linesJson } from '../src/json.js';
import { coverageBadge, coverageChart, loadProject, maintainerKey } from '../src/maintainer.js';
import { clientFor, getPlatform, refreshPlatform } from '../src/platforms/index.js';
import {
  dayKey,
  dropInstance,
  emptyActivity,
  historyPoint,
  recordChanges,
  stringifyHistory,
} from '../src/stats.js';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (path, fallback) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (fallback !== undefined && err.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read ${path}: ${err.message}`);
  }
};

function readTokens(env, log) {
  const tokens = {};
  for (const name of ['WEBLATE_TOKENS', 'TALLYGLOT_TOKENS']) {
    if (!env[name]) continue;
    try {
      Object.assign(tokens, JSON.parse(env[name]));
    } catch {
      log(`! ${name} is not valid JSON; continuing without it`);
    }
  }
  return tokens;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.root]    repository to read the config from and write into
 * @param {Function} [opts.fetch] fetch implementation (tests pass a fake)
 * @param {object} [opts.env]     environment variables
 * @param {number} [opts.now]
 * @param {Function} [opts.log]
 * @returns {Promise<{ok: boolean, snapshot: object, stats: object}>}
 */
export async function build({
  root = here,
  fetch: fetchImpl = globalThis.fetch,
  env = process.env,
  now = Date.now(),
  log = console.log,
} = {}) {
  const config = normalizeConfig(await readJson(join(root, 'tallyglot.config.json')));
  // A project maintainer can run Tallyglot for the coverage charts alone.
  if (!config.language && !config.maintainer.length) {
    throw new Error('tallyglot.config.json: "language" is required');
  }

  const snapshotPath = join(root, 'data', 'snapshot.json');
  const old = await readJson(snapshotPath, { instances: {} });
  const tokens = readTokens(env, log);
  const writeJson = async (path, value) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), `${JSON.stringify(value, null, 1)}\n`);
  };
  const activity = {
    ...emptyActivity(),
    ...(await readJson(join(root, 'data', 'activity.json'), {})),
  };
  const glossary = {
    ...emptyGlossary(),
    ...(await readJson(join(root, 'data', 'glossary.json'), {})),
  };

  const snapshot = {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    language: { code: config.language, name: config.languageName },
    instances: {},
  };
  let failed = 0;
  const clients = new Map();

  for (const instance of config.language ? config.instances.filter(isActiveInstance) : []) {
    const fingerprint = instanceFingerprint(instance, config.language);
    const before = old.instances?.[instance.id];
    const reusable = before && before.fingerprint === fingerprint;
    let known = reusable ? before.known : undefined;
    // Contribution history is counted once per change. When it has not been
    // collected for this instance yet (first run after an upgrade, or the
    // usernames changed), read the change history again from the start.
    if (
      instance.platform === 'weblate' &&
      (activity.sources[instance.id] !== fingerprint ||
        glossary.sources[instance.id] !== fingerprint)
    ) {
      dropInstance(activity, instance.id);
      dropGlossaryInstance(glossary, instance.id);
      activity.sources[instance.id] = fingerprint;
      glossary.sources[instance.id] = fingerprint;
      if (known) known = { ...known, users: {} };
    }
    const client = clientFor(instance, {
      token: tokens[instance.id],
      fetch: fetchImpl,
      headers: { 'User-Agent': 'tallyglot' },
    });

    clients.set(instance.id, client);

    let result;
    try {
      result = await refreshPlatform(client, instance, {
        language: config.language,
        known,
        previous: reusable ? before.entries : [],
        discoveryPages: config.discoveryPages,
        now,
        onChanges: (username, changes) => {
          recordChanges(activity, instance.id, username, changes);
          collectTerms(glossary, instance.id, changes);
        },
      });
    } catch (err) {
      result = {
        entries: reusable ? before.entries : [],
        known,
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
        `rate limit reached, ${result.pending || 'some'} component(s) not refreshed this run` +
          (tokens[instance.id] ? '' : ' (add a token to TALLYGLOT_TOKENS to avoid this)'),
      );
    }
    if (result.moreHistory) {
      notes.push(
        'older contribution history is still being read; more components may appear on the next run',
      );
    }
    if (result.limited || result.unreachable) failed += 1;
    log(
      `${instance.name}: ${result.entries.length} component(s), ${result.fetched} refreshed, ${client.requests} request(s)` +
        (client.rate.remaining !== null ? `, ${client.rate.remaining} left in quota` : ''),
    );
    notes.forEach((n) => log(`  ! ${n}`));

    snapshot.instances[instance.id] = {
      name: instance.name,
      platform: instance.platform,
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

  await writeJson('data/snapshot.json', snapshot);

  // Activity and history. Instances that are no longer configured are forgotten.
  const live = new Set(Object.keys(snapshot.instances));
  for (const id of Object.keys(activity.sources)) if (!live.has(id)) dropInstance(activity, id);
  for (const id of Object.keys(glossary.sources)) {
    if (!live.has(id)) dropGlossaryInstance(glossary, id);
  }
  activity.updatedAt = snapshot.generatedAt;
  glossary.updatedAt = snapshot.generatedAt;
  await writeJson('data/activity.json', activity);
  await writeFile(join(root, 'data', 'glossary.json'), linesJson(glossary, 'units'));
  // History and alerts belong to whoever the config describes. A fork starts
  // with the files of the repository it was forked from: begin afresh then.
  const owner = `${config.language}|${[...config.usernames].sort().join(',')}`.toLowerCase();
  const index = await readJson(join(root, 'data/history/index.json'), { years: [] });
  const inherited = index.owner !== undefined && index.owner !== owner;
  if (inherited) {
    for (const year of index.years)
      await rm(join(root, `data/history/${year}.json`), { force: true });
    await rm(join(root, 'data/alerts.json'), { force: true });
    index.years = [];
    log('History and alerts of a different configuration were found and cleared.');
  }
  if (entries.length) {
    const today = dayKey(now);
    const year = today.slice(0, 4);
    const file = `data/history/${year}.json`;
    await mkdir(join(root, 'data', 'history'), { recursive: true });
    const history = await readJson(join(root, file), { version: 1, year: Number(year), days: {} });
    history.days[today] = historyPoint(entries);
    await writeFile(join(root, file), stringifyHistory(history));
    const years = [...new Set([...index.years, Number(year)])].sort();
    await writeJson('data/history/index.json', { owner, years });
  }

  const badgeDir = join(root, 'badges');
  await mkdir(badgeDir, { recursive: true });
  const wanted = new Map();
  wanted.set(
    'overall.svg',
    overallBadge({ label: config.badgeLabel || snapshot.language.name, stats }),
  );
  for (const group of groupByProject(entries)) {
    wanted.set(badgeFileName(group), projectBadge({ group, languageCode: config.language }));
  }
  for (const file of await readdir(badgeDir)) {
    if (file.endsWith('.svg') && !wanted.has(file)) await rm(join(badgeDir, file));
  }
  for (const [file, svg] of wanted) await writeFile(join(badgeDir, file), svg);

  // Profile cards, in every theme.
  const who = config.team.name || config.displayName || config.usernames[0] || '';
  const card = cardData({
    entries,
    activity,
    title: who ? `${who} · ${snapshot.language.name}` : `${snapshot.language.name} translations`,
    today: dayKey(now),
  });
  await mkdir(join(root, 'cards'), { recursive: true });
  for (const theme of Object.keys(CARD_THEMES)) {
    await writeFile(join(root, 'cards', `${theme}.svg`), renderCard(card, theme));
  }

  // Find work: spend what is left of each instance's quota on its project list.
  if (config.findWork.enabled) {
    const saved = await readJson(join(root, 'data', 'findwork.json'), null);
    const index = saved?.language === config.language ? saved : emptyIndex(config.language);
    pruneIndex(index, [...clients.keys()]);
    for (const instance of config.instances.filter(isActiveInstance)) {
      const client = clients.get(instance.id);
      // Anonymous Weblate quotas are small: keep a reserve for tomorrow's refresh.
      const spare = client.rate.remaining === null ? Infinity : client.rate.remaining - 20;
      const budget = Math.min(config.findWork.requestsPerRun * (client.token ? 10 : 1), spare);
      const found = await scanInstance(index, instance, client, {
        language: config.language,
        budget,
        now,
      });
      const source = index.sources[instance.id];
      if (found || source.error) {
        log(
          `Find work, ${instance.name}: ${found} project(s) read` +
            (source.error ? `, stopped: ${source.error}` : ''),
        );
      }
    }
    await fillStars(index, { fetch: fetchImpl, githubToken: env.GITHUB_TOKEN, now });
    await writeFile(join(root, 'data', 'findwork.json'), linesJson(index, 'projects'));
  }

  await writeMaintainerFiles({ config, tokens, fetchImpl, root, now, log, writeJson });

  await sendAlerts({
    config,
    old: inherited ? { instances: {} } : old,
    entries,
    snapshot,
    root,
    env,
    now,
    log,
    fetchImpl,
    readJson,
    writeJson,
  });

  log(
    `\n${snapshot.language.name}: ${stats.percent}% across ${stats.projects} project(s), ` +
      `${stats.components} component(s). Wrote data/snapshot.json, ${wanted.size} badge(s) and ${Object.keys(CARD_THEMES).length} cards.`,
  );
  return { ok: !(failed && !entries.length), snapshot, stats };
}

/** Coverage chart, badge and data for every project under "maintainer". */
async function writeMaintainerFiles({ config, tokens, fetchImpl, root, now, log, writeJson }) {
  if (!config.maintainer.length) return;
  await mkdir(join(root, 'maintainer'), { recursive: true });
  for (const { instance: id, project } of config.maintainer) {
    const instance = config.instances.find((i) => i.id === id);
    if (!instance) {
      log(`  ! maintainer: "${id}" is not one of the configured instances`);
      continue;
    }
    const key = maintainerKey(id, project);
    try {
      const client = clientFor(instance, {
        token: tokens[id],
        fetch: fetchImpl,
        headers: { 'User-Agent': 'tallyglot' },
      });
      const view = await loadProject(getPlatform(instance.platform), client, project);
      await writeJson(`data/maintainer/${key}.json`, {
        version: 1,
        generatedAt: new Date(now).toISOString(),
        instance: id,
        platform: instance.platform,
        ...view,
      });
      await writeFile(join(root, 'maintainer', `${key}.svg`), coverageChart(view, 'light'));
      await writeFile(join(root, 'maintainer', `${key}-dark.svg`), coverageChart(view, 'dark'));
      await writeFile(join(root, 'maintainer', `${key}-badge.svg`), coverageBadge(view));
      log(`Maintainer view, ${view.project.name}: ${view.languages.length} language(s).`);
    } catch (err) {
      // The files of the previous run stay in place.
      log(`  ! maintainer: could not read "${project}" on ${instance.name}: ${err.message}`);
    }
  }
}

/** Site address for links: SITE_URL, else the default GitHub Pages address. */
function siteAddress(env) {
  if (env.SITE_URL) return env.SITE_URL.replace(/\/*$/, '/');
  const [owner, name] = String(env.GITHUB_REPOSITORY || '').split('/');
  return owner && name ? `https://${owner.toLowerCase()}.github.io/${name}/` : '';
}

async function sendAlerts(o) {
  const { config, old, entries, snapshot, root, env, now, log, fetchImpl, readJson, writeJson } = o;
  const before = Object.values(old.instances || {}).flatMap((i) => i.entries || []);
  const events = detectNewStrings(before, entries, now);
  const routed = routeEvents(events, config.alerts);
  const site = siteAddress(env);
  const language = snapshot.language.name;

  // The feed lists what the "rss" channel accepted; the page reads the same log.
  const stored = appendEvents(await readJson(join(root, 'data', 'alerts.json'), null), routed.rss);
  await writeJson('data/alerts.json', stored);
  await writeFile(
    join(root, 'feed.xml'),
    renderRss(stored.events, {
      title: `Tallyglot: new ${language} strings`,
      site,
      updated: stored.events[0]?.at || snapshot.generatedAt,
    }),
  );
  if (!events.length) return;
  log(`Alerts: ${events.length} project(s) gained strings to translate.`);

  const post = async (label, url, headers, body) => {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'tallyglot', ...headers },
        body: JSON.stringify(body),
      });
      if (!res.ok) log(`  ! ${label} answered HTTP ${res.status}`);
    } catch (err) {
      log(`  ! ${label} failed: ${err.message}`);
    }
  };
  const options = { digest: config.alerts.digest, language };
  if (routed.webhook.length) {
    if (!env.ALERT_WEBHOOK_URL) {
      log('  ! alerts.channels has "webhook" but the ALERT_WEBHOOK_URL secret is not set');
    } else {
      for (const message of buildMessages(routed.webhook, options)) {
        await post(
          'Webhook',
          env.ALERT_WEBHOOK_URL,
          {},
          webhookPayload(env.ALERT_WEBHOOK_URL, message, site),
        );
      }
    }
  }
  if (routed.issue.length) {
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) {
      log('  ! alerts.channels has "issue" but GITHUB_TOKEN / GITHUB_REPOSITORY are not set');
    } else {
      for (const message of buildMessages(routed.issue, options)) {
        await post(
          'GitHub issue',
          `${env.GITHUB_API_URL || 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/issues`,
          {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          issuePayload(message, site),
        );
      }
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  build()
    .then((result) => {
      if (!result.ok) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    });
}
