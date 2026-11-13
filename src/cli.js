// The command-line summary: argument parsing and rendering. No I/O here, so
// it can be tested; bin/tallyglot.mjs does the reading and fetching.

import { aggregate, groupByProject, isComplete } from './core.js';
import { dailyCounts, streaks, totalChanges } from './stats.js';

export const HELP = `Usage: tallyglot [options]

Prints your translation progress. Without options it reads
tallyglot.config.json and data/snapshot.json in the current folder,
and fetches fresh numbers when there is no snapshot.

Where the numbers come from
  --url <address>      a published Tallyglot dashboard, e.g. https://you.github.io/tallyglot/
  --config <file>      a config file (default: ./tallyglot.config.json)
  --lang <code>        language code, instead of a config file
  --user <name>        Weblate username(s), comma separated
  --instance <list>    hosted, codeberg, fedora and/or Weblate addresses (default: hosted)
  --refresh            fetch from the platforms even if saved numbers exist

Output
  --json               machine-readable JSON
  --limit <n>          show at most n projects (default: 15; 0 for all)
  --no-color           plain text (also: NO_COLOR=1, or when piped)
  -h, --help           this text
  -v, --version        version number

API tokens are read from TALLYGLOT_TOKENS, as JSON keyed by instance id.`;

const VALUE_FLAGS = ['url', 'config', 'lang', 'user', 'instance', 'limit'];
const BOOLEAN_FLAGS = ['refresh', 'json', 'no-color', 'help', 'version'];
const SHORT = { h: 'help', v: 'version' };

/** @returns {{options: object}|{error: string}} */
export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let name;
    let inline;
    if (/^-[a-z]$/.test(arg)) name = SHORT[arg[1]];
    else if (arg.startsWith('--')) [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (!name || ![...VALUE_FLAGS, ...BOOLEAN_FLAGS].includes(name)) {
      return { error: `Unknown option: ${arg}` };
    }
    if (BOOLEAN_FLAGS.includes(name)) {
      if (inline !== undefined) return { error: `--${name} takes no value` };
      options[name === 'no-color' ? 'noColor' : name] = true;
      continue;
    }
    const value = inline ?? argv[(i += 1)];
    if (value === undefined || (inline === undefined && value.startsWith('--'))) {
      return { error: `--${name} needs a value` };
    }
    options[name] = value;
  }
  if (options.limit !== undefined) {
    if (!/^\d+$/.test(options.limit)) return { error: '--limit needs a whole number' };
    options.limit = Number(options.limit);
  }
  if (options.url && (options.lang || options.config)) {
    return { error: '--url cannot be combined with --lang or --config' };
  }
  return { options };
}

/** Config from --lang / --user / --instance. */
export function configFromFlags({ lang, user = '', instance = 'hosted' }) {
  const split = (v) =>
    String(v)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    language: lang,
    usernames: split(user),
    instances: split(instance).map((ref) =>
      /^(hosted|codeberg|fedora)$/.test(ref) ? { id: ref } : { url: ref },
    ),
  };
}

/** The numbers both outputs are made of. */
export function summarize({ snapshot, activity, staleDays, today }) {
  const entries = Object.values(snapshot?.instances || {}).flatMap((i) => i.entries || []);
  const stats = aggregate(entries, { staleDays });
  const counts = dailyCounts(activity);
  const streak = streaks(counts, today);
  const projects = groupByProject(entries)
    .map((g) => ({
      name: g.project.name,
      instance: snapshot.instances[g.instance]?.name || g.instance,
      platform: g.entries[0].platform || 'weblate',
      percent: g.stats.percent,
      total: g.stats.total,
      translated: g.stats.translated,
      left: g.stats.untranslated + g.stats.fuzzy,
      components: g.stats.components,
      complete: g.entries.every(isComplete),
      url: g.project.url,
    }))
    // unfinished first, nearest to done on top: the order of the dashboard
    .sort(
      (a, b) => a.complete - b.complete || b.percent - a.percent || a.name.localeCompare(b.name),
    );
  return {
    language: snapshot?.language || { code: '', name: '' },
    generatedAt: snapshot?.generatedAt || null,
    percent: stats.percent,
    total: stats.total,
    translated: stats.translated,
    left: stats.untranslated + stats.fuzzy,
    projects: stats.projects,
    components: stats.components,
    complete: projects.filter((p) => p.complete).length,
    stale: stats.stale,
    contributions: activity ? totalChanges(counts) : null,
    streak: activity ? streak.current : null,
    longestStreak: activity ? streak.longest : null,
    projectList: projects,
    errors: Object.values(snapshot?.instances || {}).flatMap((i) =>
      (i.errors || []).map((e) => `${i.name}: ${e}`),
    ),
  };
}

const ANSI = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, orange: '38;5;208', cyan: 36 };
const fmt = (n) => new Intl.NumberFormat('en').format(n);

/** Width of text as a terminal shows it: wide (CJK) characters take two cells. */
export function cellWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code < 32 || (code >= 0x300 && code <= 0x36f)) continue; // control, combining
    width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u.test(ch) || code > 0x1f000 ? 2 : 1;
  }
  return width;
}

function fit(text, width) {
  let out = '';
  let used = 0;
  for (const ch of String(text)) {
    const w = cellWidth(ch);
    if (used + w > width - (cellWidth(text) > width ? 1 : 0)) break;
    out += ch;
    used += w;
  }
  if (cellWidth(text) > width) {
    out += '…';
    used += 1;
  }
  return out + ' '.repeat(Math.max(0, width - used));
}

/** The summary as text. `color` adds ANSI codes; `width` is the terminal width. */
export function renderText(summary, { color = false, limit = 15, width = 80 } = {}) {
  const paint = (text, ...styles) =>
    color ? `\x1b[${styles.map((s) => ANSI[s]).join(';')}m${text}\x1b[0m` : text;
  const tone = (p) => (p >= 100 ? 'green' : p >= 70 ? 'yellow' : p >= 40 ? 'orange' : 'red');
  const bar = (percent, size) => {
    const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * size);
    return paint('█'.repeat(filled), tone(percent)) + paint('░'.repeat(size - filled), 'dim');
  };
  const lines = [];
  const name = summary.language.name || summary.language.code || 'Translations';
  lines.push('');
  lines.push(
    `  ${paint('Tallyglot', 'bold', 'orange')}  ${paint(name, 'bold')}${summary.language.code && summary.language.name ? paint(` (${summary.language.code})`, 'dim') : ''}`,
  );
  lines.push('');
  if (!summary.components) {
    lines.push('  No translations found. Check the language code and username.');
    for (const e of summary.errors) lines.push(`  ${paint('!', 'yellow')} ${e}`);
    lines.push('');
    return lines.join('\n');
  }
  const cols = Math.max(48, Math.min(width, 100));
  lines.push(`  ${bar(summary.percent, cols - 14)} ${paint(`${summary.percent}%`, 'bold')}`);
  lines.push(
    `  ${fmt(summary.translated)} of ${fmt(summary.total)} strings · ${fmt(summary.projects)} project${summary.projects === 1 ? '' : 's'} · ` +
      `${fmt(summary.complete)} complete · ${fmt(summary.left)} left`,
  );
  if (summary.contributions !== null) {
    lines.push(
      `  ${paint(`${fmt(summary.streak)}-day streak`, summary.streak ? 'cyan' : 'dim')} · longest ${fmt(summary.longestStreak)} · ${fmt(summary.contributions)} contributions`,
    );
  }
  lines.push('');
  const shown = limit > 0 ? summary.projectList.slice(0, limit) : summary.projectList;
  const nameW = Math.min(28, Math.max(8, ...shown.map((p) => cellWidth(p.name))));
  const barW = Math.max(10, cols - nameW - 26);
  for (const p of shown) {
    const pct = `${p.percent}%`.padStart(6);
    const tail = p.complete ? paint('✓ done', 'green') : paint(`${fmt(p.left)} left`, 'dim');
    lines.push(`  ${fit(p.name, nameW)} ${bar(p.percent, barW)} ${pct}  ${tail}`);
  }
  if (shown.length < summary.projectList.length) {
    lines.push(
      paint(
        `  … and ${summary.projectList.length - shown.length} more (--limit 0 shows all)`,
        'dim',
      ),
    );
  }
  for (const e of summary.errors) lines.push(`  ${paint('!', 'yellow')} ${e}`);
  if (summary.generatedAt) {
    lines.push('');
    lines.push(
      paint(`  Numbers from ${summary.generatedAt.slice(0, 16).replace('T', ' ')} UTC`, 'dim'),
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** The summary as JSON: stable keys, for scripts. */
export function renderJson(summary) {
  const { projectList, ...rest } = summary;
  return `${JSON.stringify({ ...rest, projectList }, null, 2)}\n`;
}
