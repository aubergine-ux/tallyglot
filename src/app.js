import { WeblateClient, normalizeBaseUrl } from './api.js';
import { badgeFileName, formatPercent, overallBadge, projectBadge } from './badge.js';
import {
  SORTS,
  aggregate,
  daysSince,
  groupByProject,
  instanceFingerprint,
  isComplete,
  isStale,
  nextStringUrl,
  normalizeConfig,
  refreshInstance,
  sortEntries,
} from './core.js';
import { PRESETS } from './presets.js';
import { load, save } from './store.js';

const HOUR = 3600000;
const MIN_REFETCH_MS = 5 * 60000; // even a forced refresh skips data this fresh
const UNREACHABLE_TTL = 7 * 24 * HOUR;

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');

const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');

const state = {
  repoConfig: null, // tallyglot.config.json as committed
  config: null, // normalized, effective config (repo or browser override)
  overridden: false,
  data: {}, // instance id -> { fingerprint, entries, known, updatedAt, errors, source, limitedUntil, unreachableAt }
  prefs: { sort: 'closest', instance: 'all', stale: false, unfinished: false, query: '', ...load('prefs', {}) },
  refreshing: false,
  progress: {},
};

/* ---------- helpers ---------- */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (n) => new Intl.NumberFormat().format(n);
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function ago(iso) {
  if (!iso) return 'never';
  const sec = (new Date(iso).getTime() - Date.now()) / 1000;
  const steps = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(sec) >= size) return rtf.format(Math.round(sec / size), unit);
  }
  return 'just now';
}
const fullDate = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}

async function fetchJson(path) {
  try {
    const res = await fetch(path, { cache: 'no-cache' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const activeInstances = () =>
  state.config.instances.filter((i) => i.enabled && (i.usernames.length || i.pinned.length));
const allEntries = () => activeInstances().flatMap((i) => state.data[i.id]?.entries || []);
const instanceName = (id) => state.config.instances.find((i) => i.id === id)?.name || id;
const languageName = () =>
  state.config.languageName ||
  allEntries().find((e) => e.language?.name)?.language.name ||
  state.config.language;

function savePrefs() {
  const { query, ...rest } = state.prefs;
  save('prefs', rest);
}

function saveCache() {
  if (DEMO) return;
  const cache = {};
  for (const [id, d] of Object.entries(state.data)) {
    if (d.source !== 'snapshot' || d.limitedUntil || d.unreachableAt) cache[id] = d;
  }
  save('cache', cache);
}

/* ---------- boot ---------- */

async function boot() {
  const [repoConfig, snapshot] = await Promise.all([
    fetchJson(DEMO ? 'demo/config.json' : 'tallyglot.config.json'),
    fetchJson(DEMO ? 'demo/snapshot.json' : 'data/snapshot.json'),
  ]);
  state.repoConfig = repoConfig || { language: '', instances: PRESETS.map((p) => ({ id: p.id })) };
  const override = DEMO ? null : load('settings', null);
  state.overridden = !!override;
  state.config = normalizeConfig(override || state.repoConfig);
  state.snapshot = DEMO ? shiftDates(snapshot) : snapshot;
  adoptData();
  render();
  bindGlobal();
  if (location.hash === '#settings') openSettings();
  if (!DEMO) refresh({ force: false });
}

/** Keep the sample data looking current: move its dates forward to today. */
function shiftDates(snapshot) {
  if (!snapshot) return snapshot;
  const delta = Date.now() - new Date(snapshot.generatedAt).getTime();
  const move = (iso) => (iso ? new Date(new Date(iso).getTime() + delta).toISOString() : iso);
  for (const inst of Object.values(snapshot.instances)) {
    inst.updatedAt = move(inst.updatedAt);
    for (const e of inst.entries) {
      e.lastChange = move(e.lastChange);
      e.lastContribution = move(e.lastContribution);
      e.fetchedAt = move(e.fetchedAt);
    }
  }
  return snapshot;
}

/** Pick, per instance, the newer of the committed snapshot and the browser cache. */
function adoptData() {
  const cache = DEMO ? {} : load('cache', {});
  state.data = {};
  for (const inst of state.config.instances) {
    const fp = instanceFingerprint(inst, state.config.language);
    const snap = state.snapshot?.instances?.[inst.id];
    const cached = cache[inst.id];
    const candidates = [];
    if (snap && (DEMO || snap.fingerprint === fp)) candidates.push({ ...snap, source: 'snapshot' });
    if (cached && cached.fingerprint === fp) candidates.push(cached);
    candidates.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const best = candidates[0];
    if (!best) continue;
    state.data[inst.id] = {
      fingerprint: fp,
      entries: best.entries || [],
      known: best.known,
      updatedAt: best.updatedAt || null,
      errors: best.source === 'snapshot' ? [] : best.errors || [],
      source: best.source || 'live',
      // Blocks apply to this browser, whichever copy of the data is newer.
      limitedUntil: cached?.fingerprint === fp ? cached.limitedUntil : null,
      unreachableAt: cached?.fingerprint === fp ? cached.unreachableAt : null,
    };
  }
}

/* ---------- refresh ---------- */

async function refresh({ force }) {
  if (state.refreshing || DEMO) return;
  const now = Date.now();
  const tokens = load('tokens', {});
  const jobs = activeInstances().filter((inst) => {
    const d = state.data[inst.id];
    if (!d) return true;
    if (force) return true;
    if (d.limitedUntil && d.limitedUntil > now) return false;
    if (d.unreachableAt && now - d.unreachableAt < UNREACHABLE_TTL) return false;
    return !d.updatedAt || now - new Date(d.updatedAt).getTime() > state.config.cacheHours * HOUR;
  });
  if (!jobs.length) return;

  state.refreshing = true;
  state.progress = {};
  render();

  await Promise.all(
    jobs.map(async (inst) => {
      const before = state.data[inst.id];
      const client = new WeblateClient({ baseUrl: inst.url, token: tokens[inst.id] });
      let result;
      try {
        result = await refreshInstance(client, inst, {
          language: state.config.language,
          known: before?.known,
          previous: before?.entries || [],
          discoveryPages: state.config.discoveryPages,
          freshMs: force ? MIN_REFETCH_MS : state.config.cacheHours * HOUR,
          now,
          onProgress: (p) => {
            state.progress[inst.id] = p;
            renderStatus();
          },
        });
      } catch (err) {
        result = {
          entries: before?.entries || [],
          known: before?.known,
          errors: [err.message],
          fetched: 0,
        };
      }
      const offline = result.unreachable && navigator.onLine === false;
      const touched = result.fetched > 0 || (!result.limited && !result.unreachable);
      state.data[inst.id] = {
        fingerprint: instanceFingerprint(inst, state.config.language),
        entries: result.entries,
        known: result.known,
        updatedAt: touched ? new Date(now).toISOString() : before?.updatedAt || null,
        errors: result.unreachable ? [] : result.errors,
        source: touched ? 'live' : before?.source || 'live',
        limitedUntil: result.limited ? now + (result.retryAfter || 3600) * 1000 : null,
        unreachableAt: result.unreachable && !offline ? now : null,
        offline,
        pending: result.pending || 0,
      };
      saveCache();
    }),
  );

  state.refreshing = false;
  render();
}

/* ---------- rendering ---------- */

function render() {
  const cfg = state.config;
  document.title = cfg.language ? `${languageName()} · Tallyglot` : 'Tallyglot';
  $('#refresh').disabled = state.refreshing || DEMO;
  $('#refresh').classList.toggle('spinning', state.refreshing);

  if (!cfg.language || !activeInstances().length) {
    app.innerHTML = renderWelcome();
    return;
  }
  const entries = allEntries();
  app.innerHTML =
    (DEMO
      ? `<p class="notice info">This is sample data. <a href="./">Open the real dashboard</a></p>`
      : '') +
    renderHero(entries) +
    `<div id="status">${renderStatusInner()}</div>` +
    (entries.length
      ? renderToolbar(entries) + `<section id="grid" class="grid" aria-label="Components"></section>` + renderBadges(entries)
      : renderEmpty());
  if (entries.length) renderGrid();
}

function renderWelcome() {
  return `
    <section class="welcome card">
      <h1>Track your translations across Weblate</h1>
      <p>Enter a language code and your Weblate username to see every component you
      contribute to, how complete it is, and what still needs work.</p>
      <div class="row">
        <button class="btn primary" data-action="settings" type="button">Set up</button>
        <a class="btn" href="?demo">See a demo</a>
      </div>
    </section>`;
}

function renderEmpty() {
  const waiting = state.refreshing;
  return `
    <section class="welcome card">
      <h2>${waiting ? 'Looking for your translations…' : 'Nothing found yet'}</h2>
      <p>${
        waiting
          ? 'Reading your contribution history from each instance.'
          : `No <strong>${esc(state.config.language)}</strong> translations were found for the configured
             usernames. Check the spelling of the username and language code, or pin a project in the settings.`
      }</p>
      ${waiting ? '' : '<div class="row"><button class="btn primary" data-action="settings" type="button">Open settings</button></div>'}
    </section>`;
}

function renderHero(entries) {
  const s = aggregate(entries, { staleDays: state.config.staleDays });
  const updated = activeInstances()
    .map((i) => state.data[i.id]?.updatedAt)
    .filter(Boolean)
    .sort()[0];
  const tile = (value, label, hint = '') =>
    `<div class="tile"${hint ? ` title="${esc(hint)}"` : ''}><span class="tile-value">${value}</span><span class="tile-label">${label}</span></div>`;
  return `
    <section class="hero">
      <p class="eyebrow">${esc(languageName())} <span class="code">${esc(state.config.language)}</span></p>
      <div class="hero-main">
        <h1 class="hero-number">${entries.length ? formatPercent(s.percent) : '–'}</h1>
        <p class="hero-caption">translated across ${plural(s.projects, 'project')}
          and ${plural(s.components, 'component')}${s.instances > 1 ? ` on ${s.instances} Weblate instances` : ''}</p>
      </div>
      <div class="bar big" role="img" aria-label="${formatPercent(s.percent)} translated">
        <span style="width:${s.percent}%"></span>
      </div>
      <div class="tiles">
        ${tile(num(s.untranslated + s.fuzzy), 'strings left', `${num(s.untranslated)} untranslated, ${num(s.fuzzy)} need editing`)}
        ${tile(`${num(s.complete)}<small>/${num(s.components)}</small>`, 'components complete')}
        ${tile(num(s.stale), `stale (${state.config.staleDays}+ days)`, 'Unfinished components with no recent activity')}
        ${s.approvedPercent === null ? '' : tile(formatPercent(s.approvedPercent), 'approved', 'In projects that use reviews')}
      </div>
      <p class="updated" title="${esc(fullDate(updated))}">
        ${updated ? `Last updated ${esc(ago(updated))}` : 'Not updated yet'}
        ${state.overridden ? ' · using settings saved in this browser' : ''}
      </p>
    </section>`;
}

function renderStatusInner() {
  const now = Date.now();
  const notes = [];
  for (const inst of activeInstances()) {
    const d = state.data[inst.id];
    const name = esc(inst.name);
    const p = state.progress[inst.id];
    if (state.refreshing && p && p.done < p.total) {
      notes.push(['info', `Refreshing ${name}… ${p.done}/${p.total}`]);
    }
    if (!d) continue;
    if (d.limitedUntil && d.limitedUntil > now) {
      const kept = d.pending ? `${plural(d.pending, 'component')} could not be refreshed and show saved data. ` : 'Showing saved data. ';
      notes.push([
        'warn',
        `<strong>${name}</strong> rate limit reached. ${kept}Try again ${esc(ago(new Date(d.limitedUntil).toISOString()))},
         or add an API token in <button class="link" data-action="settings" type="button">Settings</button> to lift the limit.`,
      ]);
    } else if (d.offline) {
      notes.push(['warn', `You appear to be offline. Showing saved data for <strong>${name}</strong>.`]);
    } else if (d.unreachableAt) {
      notes.push([
        'info',
        `<strong>${name}</strong> does not allow requests from web pages (no CORS headers), so it cannot be refreshed live.
         ${d.entries.length ? `Showing the snapshot from ${esc(ago(d.updatedAt))}.` : 'Its data appears once the scheduled GitHub Action has generated a snapshot.'}`,
      ]);
    }
    for (const message of (d.errors || []).slice(0, 3)) {
      notes.push(['warn', `<strong>${name}</strong> ${esc(message)}`]);
    }
  }
  return notes.map(([kind, html]) => `<p class="notice ${kind}">${html}</p>`).join('');
}

function renderStatus() {
  const el = $('#status');
  if (el) el.innerHTML = renderStatusInner();
}

function renderToolbar(entries) {
  const p = state.prefs;
  const counts = new Map();
  for (const e of entries) counts.set(e.instance, (counts.get(e.instance) || 0) + 1);
  const chip = (id, label, count) =>
    `<button type="button" class="chip" data-instance="${esc(id)}" aria-pressed="${p.instance === id}">${esc(label)} <span class="count">${count}</span></button>`;
  const toggle = (key, label) =>
    `<button type="button" class="chip" data-toggle="${key}" aria-pressed="${!!p[key]}">${label}</button>`;
  return `
    <section class="toolbar" aria-label="Sort and filter">
      <div class="toolbar-row">
        <label class="field search">
          <span class="sr">Search</span>
          <input id="query" type="search" placeholder="Search projects…" value="${esc(p.query)}" autocomplete="off" />
        </label>
        <label class="field">
          <span>Sort</span>
          <select id="sort">
            ${Object.entries(SORTS)
              .map(([key, s]) => `<option value="${key}"${p.sort === key ? ' selected' : ''}>${s.label}</option>`)
              .join('')}
          </select>
        </label>
      </div>
      <div class="chips">
        ${counts.size > 1 ? chip('all', 'All instances', entries.length) + [...counts].map(([id, c]) => chip(id, instanceName(id), c)).join('') + '<span class="divider"></span>' : ''}
        ${toggle('unfinished', 'Unfinished')}
        ${toggle('stale', 'Stale')}
      </div>
    </section>`;
}

function visibleEntries() {
  const p = state.prefs;
  const q = p.query.trim().toLowerCase();
  const { staleDays } = state.config;
  const instances = new Set(allEntries().map((e) => e.instance));
  const filtered = allEntries().filter(
    (e) =>
      (p.instance === 'all' || !instances.has(p.instance) || e.instance === p.instance) &&
      (!p.unfinished || !isComplete(e)) &&
      (!p.stale || isStale(e, staleDays)) &&
      (!q || `${e.project.name} ${e.component.name} ${e.project.slug}`.toLowerCase().includes(q)),
  );
  return sortEntries(filtered, p.sort);
}

function renderGrid() {
  const grid = $('#grid');
  if (!grid) return;
  const entries = visibleEntries();
  grid.innerHTML = entries.length
    ? entries.map(renderCard).join('')
    : `<p class="none">No components match these filters.</p>`;
}

function bar(percent, kind, label) {
  return `
    <div class="meter">
      <div class="meter-head"><span class="meter-value">${formatPercent(percent)}</span><span class="meter-label">${label}</span></div>
      <div class="bar ${kind}" role="img" aria-label="${formatPercent(percent)} ${label}"><span style="width:${Math.max(0, Math.min(100, percent))}%"></span></div>
    </div>`;
}

function renderCard(e) {
  const { staleDays } = state.config;
  const complete = isComplete(e);
  const stale = isStale(e, staleDays);
  const multi = activeInstances().length > 1;
  const left = [];
  if (e.untranslated) left.push(`<strong>${num(e.untranslated)}</strong> untranslated`);
  if (e.fuzzy) left.push(`<strong>${num(e.fuzzy)}</strong> need editing`);
  if (e.failing) left.push(`${num(e.failing)} failing ${e.failing === 1 ? 'check' : 'checks'}`);
  if (e.suggestions) left.push(`${plural(e.suggestions, 'suggestion')}`);
  const allApproved = !e.review || e.approved >= e.total;
  const action = !complete
    ? `<a class="btn primary" href="${esc(nextStringUrl(e))}" target="_blank" rel="noopener">Translate next string <span aria-hidden="true">→</span></a>`
    : !allApproved
      ? `<a class="btn" href="${esc(nextStringUrl(e))}" target="_blank" rel="noopener">Review next string <span aria-hidden="true">→</span></a>`
      : `<a class="btn" href="${esc(e.webUrl)}" target="_blank" rel="noopener">Open in Weblate</a>`;
  const days = Math.floor(daysSince(e.lastChange));
  return `
    <article class="card entry${complete ? ' done' : ''}">
      <header class="entry-head">
        <div class="tags">
          ${multi ? `<span class="tag">${esc(instanceName(e.instance))}</span>` : ''}
          ${e.pinned ? '<span class="tag pin" title="Pinned in the config">★ Pinned</span>' : ''}
          ${complete ? '<span class="tag ok">✓ Complete</span>' : ''}
          ${stale ? `<span class="tag stale" title="No activity for ${days} days">◷ Stale</span>` : ''}
        </div>
        <p class="project"><a href="${esc(e.project.url)}" target="_blank" rel="noopener">${esc(e.project.name)}</a></p>
        <h3><a href="${esc(e.webUrl)}" target="_blank" rel="noopener">${esc(e.component.name)}</a></h3>
      </header>
      ${bar(e.translatedPercent, 'translated', 'translated')}
      ${e.review ? bar(e.approvedPercent, 'approved', 'approved') : ''}
      <p class="left">${left.length ? left.join(' · ') : `All ${plural(e.total, 'string')} translated`}</p>
      <footer class="entry-foot">
        <p class="activity">
          <span title="${esc(fullDate(e.lastChange))}">Last activity ${esc(ago(e.lastChange))}</span>
          ${e.lastContribution ? `<span title="${esc(fullDate(e.lastContribution))}">You: ${esc(ago(e.lastContribution))}</span>` : ''}
        </p>
        ${action}
      </footer>
    </article>`;
}

/* ---------- badges ---------- */

const svgUri = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const siteUrl = () => new URL('.', location.href).href;

function renderBadges(entries) {
  const stats = aggregate(entries);
  const lang = languageName();
  const label = state.config.badgeLabel || lang;
  const page = siteUrl();
  const snippet = (alt, file) => `[![${alt}](${page}badges/${file})](${page})`;
  const row = (svg, alt, file) => `
    <li class="badge-row">
      <img src="${svgUri(svg)}" alt="${esc(alt)}" height="20" />
      <code>${esc(snippet(alt, file))}</code>
      <button class="btn small" type="button" data-copy="${esc(snippet(alt, file))}">Copy</button>
    </li>`;
  const groups = groupByProject(entries).sort((a, b) => a.project.name.localeCompare(b.project.name));
  return `
    <section class="badges card" aria-labelledby="badges-title">
      <h2 id="badges-title">Badges</h2>
      <p class="muted">Static SVG images, regenerated on a schedule by the GitHub Action in this repository.
        Paste the Markdown into your GitHub profile README.</p>
      <ul class="badge-list">
        ${row(overallBadge({ label, stats }), `${lang} translation progress`, 'overall.svg')}
      </ul>
      <details>
        <summary>Per-project badges (${groups.length})</summary>
        <ul class="badge-list">
          ${groups
            .map((g) =>
              row(
                projectBadge({ group: g, languageCode: state.config.language }),
                `${g.project.name} ${lang} translation`,
                badgeFileName(g),
              ),
            )
            .join('')}
        </ul>
      </details>
    </section>`;
}

/* ---------- settings ---------- */

function renderSettings() {
  const cfg = state.config;
  const tokens = load('tokens', {});
  const instances = [...cfg.instances];
  for (const p of PRESETS) {
    if (!instances.some((i) => i.url === p.url)) {
      instances.push({ ...p, usernames: [], pinned: [], enabled: false });
    }
  }
  const own = (inst) =>
    inst.usernames.join(', ') === cfg.usernames.join(', ') ? '' : inst.usernames.join(', ');
  const row = (inst) => `
    <fieldset class="inst" data-id="${esc(inst.id)}" data-url="${esc(inst.url)}" data-name="${esc(inst.name)}">
      <label class="check">
        <input type="checkbox" name="enabled" ${inst.enabled ? 'checked' : ''} />
        <span><strong>${esc(inst.name)}</strong> <span class="muted">${esc(inst.url.replace(/^https?:\/\//, ''))}</span></span>
      </label>
      <div class="inst-fields">
        <label class="field"><span>Username here, if different</span>
          <input name="usernames" value="${esc(own(inst))}" placeholder="Same as above" autocomplete="off" autocapitalize="off" spellcheck="false" /></label>
        <label class="field"><span>Pinned projects</span>
          <input name="pinned" value="${esc(inst.pinned.join(', '))}" placeholder="project/component, project" autocomplete="off" autocapitalize="off" spellcheck="false" /></label>
        <label class="field"><span>API token (optional, stays in this browser)</span>
          <input name="token" type="password" value="${esc(tokens[inst.id] || '')}" placeholder="wlu_…" autocomplete="off" /></label>
      </div>
    </fieldset>`;
  $('#settings').innerHTML = `
    <form method="dialog" id="settings-form">
      <header class="dialog-head">
        <h2 id="settings-title">Settings</h2>
        <button class="btn icon" type="button" data-action="close-settings" aria-label="Close">✕</button>
      </header>
      <div class="dialog-body">
        <div class="pair">
          <label class="field"><span>Language code</span>
            <input name="language" value="${esc(cfg.language)}" placeholder="sq" required autocomplete="off" autocapitalize="off" spellcheck="false" /></label>
          <label class="field"><span>Weblate username(s)</span>
            <input name="usernames" value="${esc(cfg.usernames.join(', '))}" placeholder="alice, alice_b" autocomplete="off" autocapitalize="off" spellcheck="false" /></label>
        </div>
        <h3>Instances</h3>
        <div id="inst-list">${instances.map(row).join('')}</div>
        <div class="add-inst">
          <label class="field"><span>Add another Weblate instance</span>
            <input id="new-url" type="url" placeholder="https://weblate.example.org" autocomplete="off" /></label>
          <button class="btn" type="button" data-action="add-instance">Add</button>
        </div>
        <p class="muted small">
          Without a token each instance allows about 100 requests per day, which is enough for a daily refresh of
          a few dozen components. Settings saved here apply to this browser only. To make them permanent,
          copy the config and commit it as <code>tallyglot.config.json</code>.
        </p>
      </div>
      <footer class="dialog-foot">
        <button class="btn" type="button" data-action="copy-config">Copy config JSON</button>
        ${state.overridden ? '<button class="btn" type="button" data-action="reset-settings">Reset to repository config</button>' : ''}
        <span class="spacer"></span>
        <button class="btn primary" type="submit">Save</button>
      </footer>
    </form>`;
}

/** Read the settings form into a raw config object + tokens. */
function readSettings() {
  const form = $('#settings-form');
  const split = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
  const tokens = {};
  const instances = [...form.querySelectorAll('.inst')].map((el) => {
    const get = (name) => el.querySelector(`[name="${name}"]`);
    const id = el.dataset.id;
    if (get('token').value.trim()) tokens[id] = get('token').value.trim();
    const preset = PRESETS.find((p) => p.id === id && p.url === el.dataset.url);
    return {
      id,
      ...(preset ? {} : { name: el.dataset.name, url: el.dataset.url }),
      usernames: split(get('usernames').value),
      pinned: split(get('pinned').value),
      ...(get('enabled').checked ? {} : { enabled: false }),
    };
  });
  const base = state.overridden ? load('settings', {}) : state.repoConfig;
  const raw = {
    ...base,
    language: form.elements.language.value.trim(),
    usernames: split(form.querySelector('.pair [name="usernames"]').value),
    instances,
  };
  return { raw, tokens };
}

function openSettings() {
  renderSettings();
  const dialog = $('#settings');
  if (!dialog.open) dialog.showModal();
}

function applySettings() {
  const { raw, tokens } = readSettings();
  save('settings', raw);
  save('tokens', tokens);
  state.overridden = true;
  state.config = normalizeConfig(raw);
  adoptData();
  render();
  refresh({ force: false });
}

/* ---------- events ---------- */

function bindGlobal() {
  $('#refresh').addEventListener('click', () => refresh({ force: true }));
  $('#open-settings').addEventListener('click', openSettings);
  $('#theme').addEventListener('click', () => {
    const root = document.documentElement;
    const dark =
      root.dataset.theme === 'dark' ||
      (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    root.dataset.theme = dark ? 'light' : 'dark';
    state.prefs.theme = root.dataset.theme;
    savePrefs();
  });

  document.addEventListener('click', async (ev) => {
    const el = ev.target.closest('[data-action],[data-copy],[data-instance],[data-toggle]');
    if (!el) return;
    if (el.dataset.copy !== undefined) {
      try {
        await navigator.clipboard.writeText(el.dataset.copy);
        toast('Copied to clipboard');
      } catch {
        toast('Copy failed. Select the text and copy it manually.');
      }
    } else if (el.dataset.instance) {
      state.prefs.instance = el.dataset.instance;
      savePrefs();
      el.parentElement.querySelectorAll('[data-instance]').forEach((c) =>
        c.setAttribute('aria-pressed', String(c === el)),
      );
      renderGrid();
    } else if (el.dataset.toggle) {
      const key = el.dataset.toggle;
      state.prefs[key] = !state.prefs[key];
      savePrefs();
      el.setAttribute('aria-pressed', String(state.prefs[key]));
      renderGrid();
    } else if (el.dataset.action === 'settings') {
      openSettings();
    } else if (el.dataset.action === 'close-settings') {
      $('#settings').close();
    } else if (el.dataset.action === 'copy-config') {
      const { raw } = readSettings();
      try {
        await navigator.clipboard.writeText(`${JSON.stringify(raw, null, 2)}\n`);
        toast('Config copied. Commit it as tallyglot.config.json');
      } catch {
        toast('Copy failed');
      }
    } else if (el.dataset.action === 'reset-settings') {
      save('settings', null);
      state.overridden = false;
      state.config = normalizeConfig(state.repoConfig);
      $('#settings').close();
      adoptData();
      render();
      refresh({ force: false });
    } else if (el.dataset.action === 'add-instance') {
      const input = $('#new-url');
      const url = normalizeBaseUrl(input.value);
      let valid = false;
      try {
        valid = !!url && !!new URL(url).hostname.includes('.');
      } catch {}
      if (!valid) {
        toast('Enter the address of a Weblate instance');
        return;
      }
      const { raw, tokens } = readSettings();
      if (!normalizeConfig(raw).instances.some((i) => i.url === url)) {
        raw.instances.push({ url, usernames: [], pinned: [] });
      }
      // Re-render the form with the new row, keeping what was typed.
      const keep = { config: state.config, overridden: state.overridden };
      state.config = normalizeConfig(raw);
      const saved = load('tokens', {});
      save('tokens', { ...saved, ...tokens });
      renderSettings();
      state.config = keep.config;
    }
  });

  document.addEventListener('submit', (ev) => {
    if (ev.target.id === 'settings-form') applySettings();
  });
  document.addEventListener('input', (ev) => {
    if (ev.target.id === 'query') {
      state.prefs.query = ev.target.value;
      renderGrid();
    }
  });
  document.addEventListener('change', (ev) => {
    if (ev.target.id === 'sort') {
      state.prefs.sort = ev.target.value;
      savePrefs();
      renderGrid();
    }
  });
}

boot();
