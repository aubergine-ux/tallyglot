import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';

import {
  appendEvents,
  buildMessages,
  detectNewStrings,
  issuePayload,
  renderRss,
  routeEvents,
  webhookPayload,
} from '../src/alerts.js';
import { normalizeConfig } from '../src/core.js';
import { build } from '../scripts/build-data.mjs';
import { CONFIG, fakeFetch, fixture, repo, routes, run } from './helpers.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const entry = (project, component, total, translated, fuzzy = 0) => ({
  instance: 'hosted',
  project: { slug: project, name: project.toUpperCase(), url: `https://w/${project}/` },
  component: { slug: component },
  total,
  translated,
  fuzzy,
  untranslated: total - translated - fuzzy,
  platform: 'weblate',
  translateUrl: `https://w/translate/${project}/${component}/`,
});

test('detect: only projects whose source grew and that have more to do', () => {
  const before = [
    entry('a', 'x', 100, 100),
    entry('a', 'y', 50, 50),
    entry('b', 'x', 100, 90),
    entry('c', 'x', 100, 80),
    entry('d', 'x', 100, 100),
  ];
  const after = [
    entry('a', 'x', 130, 100), // 30 new
    entry('a', 'y', 50, 50),
    entry('b', 'x', 100, 95), // progress only
    entry('c', 'x', 110, 100), // grew, but translators kept up
    entry('d', 'x', 105, 103, 2), // 5 new, 2 already drafted
    entry('e', 'x', 500, 0), // first sighting is not news
  ];
  const events = detectNewStrings(before, after, NOW);
  assert.deepEqual(
    events.map((e) => [e.project, e.added, e.waiting, e.url]),
    [
      ['hosted:a', 30, 30, 'https://w/translate/a/x/?q=state:empty'],
      ['hosted:d', 2, 2, 'https://w/translate/d/x/?q=state:needs-editing'],
    ],
  );
  assert.equal(events[0].at, '2026-11-12T12:00:00.000Z');
  assert.deepEqual(detectNewStrings([], after), []);
  assert.deepEqual(detectNewStrings(after, []), []);
});

test('route: channels, thresholds and per-project overrides', () => {
  const events = [
    { project: 'hosted:a', added: 30 },
    { project: 'hosted:b', added: 2 },
    { project: 'hosted:c', added: 50 },
    { project: 'hosted:d', added: 5 },
  ];
  const { alerts } = normalizeConfig({
    alerts: {
      channels: ['rss', 'webhook', 'smoke-signal'],
      minStrings: 5,
      projects: {
        'hosted:c': false,
        'hosted:d': { channels: ['issue'] },
        'hosted:b': { minStrings: 1 },
      },
    },
  });
  const routed = routeEvents(events, alerts);
  const ids = (list) => list.map((e) => e.project);
  assert.deepEqual(ids(routed.rss), ['hosted:a', 'hosted:b']);
  assert.deepEqual(ids(routed.webhook), ['hosted:a', 'hosted:b']);
  assert.deepEqual(ids(routed.issue), ['hosted:d']);
  // defaults: the feed only, as a digest, from the first string
  assert.deepEqual(normalizeConfig({}).alerts, {
    channels: ['rss'],
    digest: true,
    minStrings: 1,
    projects: {},
  });
  assert.equal(normalizeConfig({ alerts: { digest: false, channels: [] } }).alerts.digest, false);
  assert.deepEqual(normalizeConfig({ alerts: { channels: [] } }).alerts.channels, []);
});

const EVENTS = [
  {
    project: 'hosted:a',
    name: 'A & <B>',
    added: 30,
    waiting: 31,
    percent: 76.5,
    url: 'https://w/a?x=1&y=2',
    at: '2026-11-12T12:00:00.000Z',
  },
  {
    project: 'hosted:d',
    name: 'D',
    added: 1,
    waiting: 1,
    percent: 99,
    url: 'https://w/d',
    at: '2026-11-12T12:00:00.000Z',
  },
];

test('messages: digest is one message, otherwise one per project', () => {
  const digest = buildMessages(EVENTS, { digest: true, language: 'Albanian' });
  assert.equal(digest.length, 1);
  assert.equal(digest[0].title, '31 new strings to translate in 2 projects (Albanian)');
  assert.equal(digest[0].lines[1].text, 'D: 1 new string (1 string waiting, 99% translated)');
  const each = buildMessages(EVENTS, { digest: false, language: 'Albanian' });
  assert.deepEqual(
    each.map((m) => m.title),
    ['New strings to translate in A & <B> (Albanian)', 'New strings to translate in D (Albanian)'],
  );
  assert.deepEqual(buildMessages([], { digest: true }), []);
});

test('payloads: Discord, Slack and GitHub each get their own format', () => {
  const [message] = buildMessages(EVENTS, { digest: true, language: 'Albanian' });
  const discord = webhookPayload('https://discord.com/api/webhooks/1/abc', message, 'https://s/');
  assert.deepEqual(Object.keys(discord), ['content']);
  assert.match(discord.content, /^\*\*31 new strings/);
  assert.match(discord.content, /• \[A & <B>: 30 new strings .*\]\(https:\/\/w\/a\?x=1&y=2\)/);
  assert.match(discord.content, /\[Open Tallyglot\]\(https:\/\/s\/\)$/);
  const slack = webhookPayload('https://hooks.slack.com/services/T/B/x', message, '');
  assert.deepEqual(Object.keys(slack), ['text']);
  assert.match(slack.text, /^\*31 new strings.*\*\n• <https:\/\/w\/a\?x=1&y=2\|A & <B>: 30/);
  // Discord's Slack-compatible endpoint takes the Slack format
  assert.ok(webhookPayload('https://discord.com/api/webhooks/1/abc/slack', message).text);
  const long = {
    title: 't',
    lines: Array.from({ length: 200 }, (_, i) => ({
      text: `project ${i} has new strings`,
      url: 'https://w/x',
    })),
  };
  assert.ok(webhookPayload('https://discord.com/api/webhooks/1/abc', long).content.length <= 2000);
  const issue = issuePayload(message, 'https://s/');
  assert.equal(issue.title, message.title);
  assert.match(issue.body, /^- \[A & <B>: 30 new strings/);
  assert.deepEqual(issue.labels, ['translations']);
});

test('rss: valid, escaped, newest first and capped', () => {
  const xml = renderRss(EVENTS, { title: 'T & co', site: 'https://s/', updated: EVENTS[0].at });
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<rss version="2.0">/);
  assert.ok(xml.includes('<title>T &#38; co</title>'));
  assert.ok(xml.includes('<link>https://w/a?x=1&#38;y=2</link>'));
  assert.ok(xml.includes('<title>A &#38; &#60;B&#62;: 30 new strings'));
  assert.ok(xml.includes('<pubDate>Thu, 12 Nov 2026 12:00:00 GMT</pubDate>'));
  assert.equal(xml.match(/<item>/g).length, 2);
  assert.ok(!/<item>/.test(renderRss([], { title: 't', site: '', updated: NOW })));
  const many = Array.from({ length: 150 }, (_, i) => ({
    project: `p${i}`,
    at: new Date(NOW - i * 1000).toISOString(),
  }));
  const log = appendEvents({ events: many.slice(50) }, many.slice(0, 50));
  assert.equal(log.events.length, 100);
  assert.equal(log.events[0].project, 'p0');
  assert.equal(appendEvents(null, []).events.length, 0);
});

test('build: new strings reach the feed, the webhook and an issue', async () => {
  const r = await repo({
    ...CONFIG,
    alerts: { channels: ['rss', 'webhook', 'issue'], digest: true },
  });
  const posts = [];
  const grown = structuredClone(fixture('weblate-translation-trale-localizations-sq'));
  grown.total += 25;
  const fetchWith = (extra) => {
    const get = fakeFetch(routes(extra));
    return async (url, init = {}) => {
      if (init.method === 'POST') {
        posts.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        return { ok: url.includes('discord'), status: url.includes('discord') ? 204 : 403 };
      }
      return get(url, init);
    };
  };
  const env = {
    TALLYGLOT_TOKENS: '{"crowdin":"tok"}',
    ALERT_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc',
    GITHUB_TOKEN: 'ghs_x',
    GITHUB_REPOSITORY: 'Alice/tallyglot',
  };
  try {
    await build({ root: r.root, fetch: fetchWith([]), env, now: NOW, log: () => {} });
    assert.equal(posts.length, 0, 'the first run has nothing to compare with');
    assert.equal((await r.read('data/alerts.json')).events.length, 0);
    assert.match(
      await r.text('feed.xml'),
      /<link>https:\/\/alice\.github\.io\/tallyglot\/<\/link>/,
    );

    const lines = [];
    const T = 'https://hosted.weblate.org/api/translations/trale/localizations/sq/';
    await build({
      root: r.root,
      fetch: fetchWith([[new RegExp(`${T.replace(/[/.]/g, '\\$&')}$`), grown]]),
      env,
      now: NOW + 86400000,
      log: (l) => lines.push(l),
    });
    const { events } = await r.read('data/alerts.json');
    assert.deepEqual(
      events.map((e) => [e.project, e.added]),
      [['hosted:trale', 25]],
    );
    assert.match(await r.text('feed.xml'), /<title>trale: 25 new strings \(34 strings waiting/);
    assert.equal(posts.length, 2);
    assert.match(posts[0].body.content, /25 new strings to translate in 1 project \(Albanian\)/);
    assert.equal(posts[1].url, 'https://api.github.com/repos/Alice/tallyglot/issues');
    assert.equal(posts[1].headers.Authorization, 'Bearer ghs_x');
    assert.match(posts[1].body.title, /25 new strings/);
    // a channel that refuses is reported, and the run still succeeds
    assert.ok(lines.some((l) => /GitHub issue answered HTTP 403/.test(l)));

    // Third run, nothing new: silent, and the feed keeps the earlier item.
    posts.length = 0;
    await build({
      root: r.root,
      fetch: fetchWith([[new RegExp(`${T.replace(/[/.]/g, '\\$&')}$`), grown]]),
      env,
      now: NOW + 2 * 86400000,
      log: () => {},
    });
    assert.equal(posts.length, 0);
    assert.equal((await r.read('data/alerts.json')).events.length, 1);
  } finally {
    await rm(r.root, { recursive: true });
  }
});

test('build: a channel without its secret is skipped with a note', async () => {
  const r = await repo({ ...CONFIG, alerts: { channels: ['webhook'] } });
  try {
    await run(r);
    const grown = structuredClone(fixture('weblate-translation-trale-localizations-sq'));
    grown.total += 3;
    const lines = [];
    await run(r, {
      now: NOW + 86400000,
      routes: routes([[/trale\/localizations\/sq\/$/, grown]]),
      log: (l) => lines.push(l),
    });
    assert.ok(lines.some((l) => /ALERT_WEBHOOK_URL secret is not set/.test(l)));
    assert.equal((await r.read('data/alerts.json')).events.length, 0); // rss channel is off
  } finally {
    await rm(r.root, { recursive: true });
  }
});
