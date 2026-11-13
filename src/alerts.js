// Alerts: notice when a tracked project gains untranslated strings, and tell
// the translator through an RSS feed, a Discord/Slack webhook, or a GitHub issue.
// Pure functions here; scripts/build-data.mjs does the sending.

import { groupByProject, nextStringUrl } from './core.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const CHANNELS = ['rss', 'webhook', 'issue'];
const MAX_EVENTS = 100;

/**
 * Compare two sets of entries. A project is reported when its source grew
 * and it has more strings waiting than before. Projects seen for the first
 * time are not news.
 *
 * @returns {{project: string, name: string, added: number, waiting: number,
 *            percent: number, url: string, at: string}[]}
 */
export function detectNewStrings(before, after, now = Date.now()) {
  const waiting = (g) => g.stats.untranslated + g.stats.fuzzy;
  const old = new Map(groupByProject(before).map((g) => [g.key, g]));
  const events = [];
  for (const g of groupByProject(after)) {
    const prev = old.get(g.key);
    if (!prev) continue;
    const added = Math.min(g.stats.total - prev.stats.total, waiting(g) - waiting(prev));
    if (added <= 0) continue;
    // Link to the component with the most work, on its "next string" address.
    const busiest = [...g.entries].sort(
      (a, b) => b.untranslated + b.fuzzy - (a.untranslated + a.fuzzy),
    )[0];
    events.push({
      project: g.key,
      name: g.project.name,
      added,
      waiting: waiting(g),
      percent: g.stats.percent,
      url: nextStringUrl(busiest) || g.project.url,
      at: new Date(now).toISOString(),
    });
  }
  return events.sort((a, b) => b.added - a.added || a.name.localeCompare(b.name));
}

/**
 * Apply the config: which events go to which channel.
 * alerts.projects maps "instance:project" to false (mute) or
 * { channels, minStrings } (override).
 */
export function routeEvents(events, alerts) {
  const out = Object.fromEntries(CHANNELS.map((c) => [c, []]));
  for (const event of events) {
    const own = alerts.projects?.[event.project];
    if (own === false) continue;
    const rule = own && typeof own === 'object' ? own : {};
    const min = Number(rule.minStrings) > 0 ? Number(rule.minStrings) : alerts.minStrings;
    if (event.added < min) continue;
    const channels = Array.isArray(rule.channels) ? rule.channels : alerts.channels;
    for (const channel of channels) if (out[channel]) out[channel].push(event);
  }
  return out;
}

export const eventLine = (e) =>
  `${e.name}: ${plural(e.added, 'new string')} (${plural(e.waiting, 'string')} waiting, ${e.percent}% translated)`;

/**
 * Messages to send for a channel: one for everything (digest) or one per project.
 * Each is { title, lines: [{ text, url }] }.
 */
export function buildMessages(events, { digest, language }) {
  if (!events.length) return [];
  if (!digest) {
    return events.map((e) => ({
      title: `New strings to translate in ${e.name} (${language})`,
      lines: [{ text: eventLine(e), url: e.url }],
    }));
  }
  const total = events.reduce((n, e) => n + e.added, 0);
  return [
    {
      title: `${plural(total, 'new string')} to translate in ${plural(events.length, 'project')} (${language})`,
      lines: events.map((e) => ({ text: eventLine(e), url: e.url })),
    },
  ];
}

/** Discord and Slack both take Markdown-ish text, under different keys. */
export function webhookPayload(url, message, site) {
  const discord = /discord(app)?\.com\/api\/webhooks/.test(url) && !/\/slack\/?$/.test(url);
  const link = (text, href) => (discord ? `[${text}](${href})` : `<${href}|${text}>`);
  const bold = (text) => (discord ? `**${text}**` : `*${text}*`);
  const body = [
    bold(message.title),
    ...message.lines.map((l) => `• ${link(l.text, l.url)}`),
    site ? link('Open Tallyglot', site) : '',
  ]
    .filter(Boolean)
    .join('\n');
  // Discord refuses messages over 2000 characters.
  const text = body.length > 1900 ? `${body.slice(0, 1890)}\n…` : body;
  return discord ? { content: text } : { text };
}

export function issuePayload(message, site) {
  return {
    title: message.title,
    body:
      `${message.lines.map((l) => `- [${l.text}](${l.url})`).join('\n')}\n\n` +
      (site ? `[Open the dashboard](${site})\n\n` : '') +
      `<sub>Opened by the Tallyglot workflow. Close it when you are done; a new one is opened the next time strings are added.</sub>\n`,
    labels: ['translations'],
  };
}

/** Add events to the stored log, newest first, capped. */
export function appendEvents(log, events) {
  return {
    version: 1,
    events: [...events, ...(log?.events || [])]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, MAX_EVENTS),
  };
}

/** RSS 2.0 feed of the stored events. */
export function renderRss(events, { title, site, updated }) {
  const items = events
    .map(
      (e) =>
        `  <item>\n` +
        `   <title>${esc(eventLine(e))}</title>\n` +
        `   <link>${esc(e.url)}</link>\n` +
        `   <guid isPermaLink="false">${esc(`${e.project}@${e.at}`)}</guid>\n` +
        `   <pubDate>${new Date(e.at).toUTCString()}</pubDate>\n` +
        `   <description>${esc(`${plural(e.added, 'new string')} to translate in ${e.name}.`)}</description>\n` +
        `  </item>`,
    )
    .join('\n');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n <channel>\n` +
    `  <title>${esc(title)}</title>\n  <link>${esc(site || '')}</link>\n` +
    `  <description>New strings to translate in the projects tracked by Tallyglot.</description>\n` +
    `  <lastBuildDate>${new Date(updated).toUTCString()}</lastBuildDate>\n` +
    (items ? `${items}\n` : '') +
    ` </channel>\n</rss>\n`
  );
}
