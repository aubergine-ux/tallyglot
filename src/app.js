import { normalizeBaseUrl } from './api.js';
import { badgeFileName, formatPercent, overallBadge, projectBadge } from './badge.js';
import {
  SORTS,
  aggregate,
  daysSince,
  hasUnreadHistory,
  groupByProject,
  instanceFingerprint,
  isActiveInstance,
  isComplete,
  isStale,
  nextStringUrl,
  normalizeConfig,
  sortEntries,
} from './core.js';
import { currentLocale, matchLocale, setLocale, t, tt } from './i18n.js';
import { clientFor, getPlatform, refreshPlatform } from './platforms/index.js';
import { PLATFORM_META, PRESETS } from './presets.js';
import { load, save } from './store.js';
import {
  $,
  $$,
  ago,
  copyText,
  esc,
  fetchJson,
  fullDate,
  num,
  reviewSeason,
  siteUrl,
  svgUri,
  toast,
} from './ui.js';

const HOUR = 3600000;
const MIN_REFETCH_MS = 5 * 60000; // even a forced refresh skips data this fresh
const UNREACHABLE_TTL = 7 * 24 * HOUR;

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');

const app = $('#app');
const DATA_DIR = DEMO ? 'demo' : 'data';

const state = {
  repoConfig: null, // tallyglot.config.json as committed
  config: null, // normalized, effective config (repo or browser override)
  overridden: false,
  data: {}, // instance id -> { fingerprint, entries, known, updatedAt, errors, source, limitedUntil, unreachableAt }
  prefs: {
    instance: 'all',
    stale: false,
    unfinished: false,
    query: '',
    sort: 'closest',
    ...load('prefs', {}),
  },
  refreshing: false,
  progress: {},
  view: 'dashboard',
  locales: { en: 'English' },
  files: {}, // data files requested by pages, by name
};

// Pages other than the dashboard load on first visit.
const PAGES = {
  stats: () => import('./views/stats.js'),
  review: () => import('./views/review.js'),
  glossary: () => import('./views/glossary.js'),
  find: () => import('./views/find.js'),
  team: () => import('./views/team.js'),
  setup: () => import('./views/setup.js'),
  maintainer: () => import('./views/maintainer.js'),
  wrapped: () => import('./views/wrapped.js'),
  portfolio: () => import('./views/portfolio.js'),
};
const NAV = ['dashboard', 'stats', 'review', 'glossary', 'find', 'team'];

/* ---------- helpers ---------- */

const activeInstances = () => state.config.instances.filter(isActiveInstance);
const allEntries = () => activeInstances().flatMap((i) => state.data[i.id]?.entries || []);
const instanceName = (id) => state.config.instances.find((i) => i.id === id)?.name || id;
const configured = () => !!state.config.language && activeInstances().length > 0;
const languageName = () =>
  state.config.languageName ||
  allEntries().find((e) => e.language?.name)?.language.name ||
  state.config.language;

function savePrefs() {
  // Sort order, theme and interface language are remembered; filters start
  // fresh on every visit.
  const { sort, theme, locale } = state.prefs;
  save('prefs', { sort, theme, locale });
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
    fetchJson(`${DATA_DIR}/snapshot.json`),
    loadLocale(),
  ]);
  state.repoConfig = repoConfig || { language: '', instances: PRESETS.map((p) => ({ id: p.id })) };
  const override = DEMO ? null : load('settings', null);
  state.overridden = !!override;
  state.config = normalizeConfig(override || state.repoConfig);
  state.snapshot = DEMO ? shiftDates(snapshot) : snapshot;
  state.view = viewFromUrl();
  adoptData();
  renderShell();
  render();
  bindGlobal();
  if (location.hash === '#settings') openSettings();
  if (!DEMO) refresh({ force: false });
  if ('serviceWorker' in navigator && isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

/** Load the interface language: the saved choice, else the browser's, else English. */
async function loadLocale() {
  const [available, english] = await Promise.all([
    fetchJson('locales/index.json'),
    fetchJson('locales/en.json'),
  ]);
  state.locales = available || { en: 'English' };
  const code = matchLocale(state.locales, [
    params.get('lang'),
    state.prefs.locale,
    ...(navigator.languages || []),
  ]);
  const dict = code === 'en' ? english : await fetchJson(`locales/${code}.json`);
  setLocale(dict ? code : 'en', dict || english || {}, english || {});
  document.documentElement.lang = currentLocale().replace(/_/g, '-');
  document.documentElement.dir = /^(ar|he|fa|ur|ckb|yi)\b/.test(currentLocale()) ? 'rtl' : 'ltr';
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
    // Platforms without CORS headers are only ever read by the Action.
    if (getPlatform(inst.platform).browser === false) return false;
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
      const client = clientFor(inst, { token: tokens[inst.id] });
      let result;
      try {
        result = await refreshPlatform(client, inst, {
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
      const touched =
        result.fetched > 0 || (!result.limited && !result.unreachable && !result.needsToken);
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

/* ---------- pages ---------- */

function viewFromUrl() {
  const view = new URLSearchParams(location.search).get('view');
  return view && PAGES[view] ? view : 'dashboard';
}

/** Address of a page, keeping ?demo. `query` adds page parameters. */
function pageUrl(view, query = {}) {
  const q = new URLSearchParams();
  if (DEMO) q.set('demo', '');
  if (view !== 'dashboard') q.set('view', view);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') q.set(key, value);
  }
  const text = q.toString().replace(/=(?=&|$)/g, '');
  return text ? `?${text}` : './';
}

function navigate(view, query, { replace = false } = {}) {
  const url = pageUrl(view, query);
  history[replace ? 'replaceState' : 'pushState'](null, '', url);
  state.view = viewFromUrl();
  render();
  if (!replace) {
    scrollTo(0, 0);
    // Tell keyboard and screen reader users that the page changed.
    app.focus({ preventScroll: true });
  }
}

const ownerOf = (cfg) => `${cfg.language}|${[...cfg.usernames].sort().join(',')}`.toLowerCase();

/** Do the files the Action committed belong to the configuration in use? */
function recordsApply(name) {
  if (DEMO || !state.overridden || name.startsWith('maintainer/')) return true;
  return ownerOf(state.config) === ownerOf(normalizeConfig(state.repoConfig));
}

/** What a page gets to work with. */
const ctx = {
  state,
  demo: DEMO,
  get config() {
    return state.config;
  },
  get query() {
    return new URLSearchParams(location.search);
  },
  entries: () => allEntries(),
  configured,
  activeInstances,
  instanceName,
  languageName: () => languageName(),
  tokens: () => (DEMO ? {} : load('tokens', {})),
  /** A JSON file written by the Action (data/<name>.json), or null. Fetched once. */
  file(name) {
    // The Action's records describe whoever the repository is configured for.
    // A visitor trying their own settings in this browser must not be shown them.
    if (!recordsApply(name)) return Promise.resolve(null);
    state.files[name] ||= fetchJson(`${DATA_DIR}/${name}.json`).then((json) =>
      // The sample data is dated; bring it forward to today like the snapshot.
      DEMO && json ? import('./demo.js').then((m) => m.shiftDemo(name, json)) : json,
    );
    return state.files[name];
  },
  navigate,
  pageUrl,
  openSettings: () => openSettings(),
};

function renderShell() {
  $('#nav').innerHTML = NAV.map(
    (view) => `<a href="${pageUrl(view)}" data-nav="${view}">${t(`nav.${view}`)}</a>`,
  ).join('');
  $('#skip').textContent = tt('shell.skip');
  $('#refresh span').textContent = tt('shell.refresh');
  $('#open-settings span').textContent = tt('shell.settings');
  for (const id of ['theme', 'refresh', 'open-settings']) {
    const label = tt(`shell.${id === 'open-settings' ? 'settings' : id}`);
    $(`#${id}`).setAttribute('aria-label', label);
    $(`#${id}`).title = label;
  }
  $('#nav').setAttribute('aria-label', tt('shell.pages'));
  $('#foot').innerHTML = `
    <nav aria-label="${t('shell.more')}">
      ${['setup', 'maintainer', 'portfolio', 'wrapped']
        .map((view) => `<a href="${pageUrl(view)}" data-nav="${view}">${t(`nav.${view}`)}</a>`)
        .join('')}
    </nav>
    <p>${t('shell.footer')}</p>`;
}

let renderCount = 0;

async function render() {
  const view = state.view;
  const turn = ++renderCount;
  $('#refresh').disabled = state.refreshing || DEMO;
  $('#refresh').classList.toggle('spinning', state.refreshing);
  for (const link of $$('[data-nav]')) {
    if (link.dataset.nav === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  const lang = state.config.language ? `${languageName()} · ` : '';
  document.title =
    view === 'dashboard' ? `${lang}Tallyglot` : `${tt(`nav.${view}`)} · ${lang}Tallyglot`;
  document.body.dataset.view = view;

  if (view === 'dashboard') {
    renderDashboard();
    return;
  }
  if (app.dataset.page !== view) app.innerHTML = `<p class="loading">${t('shell.loading')}</p>`;
  app.dataset.page = view;
  if (!$('#pages-css')) {
    document.head.insertAdjacentHTML(
      'beforeend',
      '<link id="pages-css" rel="stylesheet" href="assets/pages.css" />',
    );
  }
  try {
    const page = await PAGES[view]();
    const html = await page.render(ctx);
    if (turn !== renderCount) return; // a newer render took over while this one waited
    // A fresh wrapper per render, so listeners a page adds go away with it.
    app.innerHTML = `${demoNotice()}<div class="page" id="page">${html}</div>`;
    page.bind?.($('#page'), ctx);
  } catch (err) {
    if (turn !== renderCount) return;
    app.innerHTML = `<section class="welcome card"><h1>${t('shell.pageFailed')}</h1><p>${esc(err.message)}</p></section>`;
  }
}

const demoNotice = () =>
  DEMO ? `<p class="notice info">${t('shell.demo', { href: './' })}</p>` : '';

/* ---------- dashboard ---------- */

/** In December and January, point at the year in review. */
function seasonNotice() {
  const year = reviewSeason();
  if (!year) return '';
  return `<p class="notice info">${t('wrapped.banner', { year: String(year) })}
    <a href="${pageUrl('wrapped', { year })}" data-nav="wrapped">${t('wrapped.bannerLink')}</a></p>`;
}

function renderDashboard() {
  app.dataset.page = 'dashboard';
  if (!configured()) {
    app.innerHTML = renderWelcome();
    return;
  }
  const entries = allEntries();
  app.innerHTML =
    demoNotice() +
    seasonNotice() +
    renderHero(entries) +
    `<div id="status" role="status">${renderStatusInner()}</div>` +
    (entries.length
      ? renderToolbar(entries) +
        `<section id="grid" class="grid" aria-label="${t('dash.components')}"></section>` +
        renderBadges(entries)
      : renderEmpty());
  if (entries.length) renderGrid();
}

function renderWelcome() {
  return `
    <section class="welcome card">
      <h1>${t('welcome.title')}</h1>
      <p>${t('welcome.text')}</p>
      <div class="row">
        <a class="btn primary" href="${pageUrl('setup')}" data-nav="setup">${t('welcome.guided')}</a>
        <button class="btn" data-action="settings" type="button">${t('welcome.setUp')}</button>
        <a class="btn" href="?demo">${t('welcome.demo')}</a>
      </div>
    </section>`;
}

function renderEmpty() {
  const waiting = state.refreshing;
  return `
    <section class="welcome card">
      <h2>${waiting ? t('empty.looking') : t('empty.nothing')}</h2>
      <p>${waiting ? t('empty.reading') : t('empty.hint', { language: state.config.language })}</p>
      ${waiting ? '' : `<div class="row"><button class="btn primary" data-action="settings" type="button">${t('empty.open')}</button></div>`}
    </section>`;
}

function renderHero(entries) {
  const s = aggregate(entries, { staleDays: state.config.staleDays });
  const updated = activeInstances()
    .map((i) => state.data[i.id]?.updatedAt)
    .filter(Boolean)
    .sort()[0];
  const tile = (value, label, hint = '') =>
    `<div class="tile"${hint ? ` title="${hint}"` : ''}><span class="tile-value">${value}</span><span class="tile-label">${label}</span></div>`;
  return `
    <section class="hero">
      <p class="eyebrow">${esc(languageName())} <span class="code">${esc(state.config.language)}</span></p>
      <div class="hero-main">
        <h1 class="hero-number">${entries.length ? formatPercent(s.percent) : '–'}</h1>
        <p class="hero-caption">${t(s.instances > 1 ? 'hero.captionMany' : 'hero.caption', {
          projects: { html: t('count.projects', { count: s.projects }) },
          components: { html: t('count.components', { count: s.components }) },
          instances: s.instances,
        })}</p>
      </div>
      <div class="bar big" role="img" aria-label="${t('hero.barLabel', { percent: formatPercent(s.percent) })}">
        <span style="width:${s.percent}%"></span>
      </div>
      <div class="tiles">
        ${tile(num(s.untranslated + s.fuzzy), t('hero.left'), t('hero.leftHint', { untranslated: s.untranslated, fuzzy: s.fuzzy }))}
        ${tile(`${num(s.complete)}<small>/${num(s.components)}</small>`, t('hero.complete'))}
        ${tile(num(s.stale), t('hero.stale', { days: state.config.staleDays }), t('hero.staleHint'))}
        ${s.approvedPercent === null ? '' : tile(formatPercent(s.approvedPercent), t('hero.approved'), t('hero.approvedHint'))}
      </div>
      <p class="updated" title="${esc(fullDate(updated))}">
        ${updated ? t('hero.updated', { when: ago(updated) }) : t('hero.notUpdated')}
        ${state.overridden ? ` · ${t('hero.overridden')}` : ''}
      </p>
    </section>`;
}

function renderStatusInner() {
  const now = Date.now();
  const notes = [];
  const settings = (label) => ({
    html: `<button class="link" data-action="settings" type="button">${label}</button>`,
  });
  for (const inst of activeInstances()) {
    const d = state.data[inst.id];
    const name = { html: `<strong>${esc(inst.name)}</strong>` };
    const p = state.progress[inst.id];
    if (state.refreshing && p && p.done < p.total) {
      notes.push(['info', t('status.refreshing', { name, done: p.done, total: p.total })]);
    }
    if (!d) {
      if (getPlatform(inst.platform).browser === false) {
        notes.push(['info', t('status.actionOnly', { name })]);
      }
      continue;
    }
    if (d.limitedUntil && d.limitedUntil > now) {
      notes.push([
        'warn',
        t('status.limited', {
          name,
          kept: {
            html: d.pending ? t('status.keptSome', { count: d.pending }) : t('status.keptAll'),
          },
          when: ago(new Date(d.limitedUntil).toISOString()),
          settings: settings(t('shell.settings')),
        }),
      ]);
    } else if (d.offline) {
      notes.push(['warn', t('status.offline', { name })]);
    } else if (d.unreachableAt) {
      notes.push([
        'info',
        `${t('status.unreachable', { name })} ${
          d.entries.length
            ? t('status.unreachableSnapshot', { when: ago(d.updatedAt) })
            : t('status.unreachableEmpty')
        }`,
      ]);
    }
    if (!state.refreshing && hasUnreadHistory(d.known)) {
      notes.push([
        'info',
        t('status.moreHistory', { name, settings: settings(t('shell.settings')) }),
      ]);
    }
    for (const message of (d.errors || []).slice(0, 3)) {
      notes.push(['warn', `<strong>${esc(inst.name)}</strong> ${esc(message)}`]);
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
    <section class="toolbar" aria-label="${t('toolbar.label')}">
      <div class="toolbar-row">
        <label class="field search">
          <span class="sr">${t('toolbar.search')}</span>
          <input id="query" type="search" placeholder="${t('toolbar.searchHint')}" value="${esc(p.query)}" autocomplete="off" />
        </label>
        <label class="field">
          <span>${t('toolbar.sort')}</span>
          <select id="sort">
            ${Object.keys(SORTS)
              .map(
                (key) =>
                  `<option value="${key}"${p.sort === key ? ' selected' : ''}>${t(`sort.${key}`)}</option>`,
              )
              .join('')}
          </select>
        </label>
      </div>
      <div class="chips" role="group" aria-label="${t('toolbar.filters')}">
        ${counts.size > 1 ? chip('all', tt('toolbar.all'), entries.length) + [...counts].map(([id, c]) => chip(id, instanceName(id), c)).join('') + '<span class="divider"></span>' : ''}
        ${toggle('unfinished', t('toolbar.unfinished'))}
        ${toggle('stale', t('toolbar.stale'))}
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
    : `<p class="none">${t('dash.noMatch')}</p>`;
}

function bar(percent, kind, label) {
  return `
    <div class="meter">
      <div class="meter-head"><span class="meter-value">${formatPercent(percent)}</span> <span class="meter-label">${label}</span></div>
      <div class="bar ${kind}" role="img" aria-label="${formatPercent(percent)} ${label}"><span style="width:${Math.max(0, Math.min(100, percent))}%"></span></div>
    </div>`;
}

/** "Hosted Weblate", or "Example · Weblate" when the name does not say it. */
function platformLabel(e) {
  const name = instanceName(e.instance);
  const platform = PLATFORM_META[e.platform || 'weblate'].name;
  return name.toLowerCase().includes(platform.toLowerCase()) ? name : `${name} · ${platform}`;
}

function renderCard(e) {
  const { staleDays } = state.config;
  const complete = isComplete(e);
  const stale = isStale(e, staleDays);
  const platform = PLATFORM_META[e.platform || 'weblate'].name;
  const left = [];
  if (e.untranslated) left.push(t('card.untranslated', { count: e.untranslated }));
  if (e.fuzzy) left.push(t('card.fuzzy', { count: e.fuzzy }));
  if (e.failing) left.push(t('card.failing', { count: e.failing }));
  if (e.suggestions) left.push(t('card.suggestions', { count: e.suggestions }));
  const allApproved = !e.review || e.approved >= e.total;
  const arrow = '<span aria-hidden="true">→</span>';
  const name = `${e.project.name} – ${e.component.name}`;
  const link = (cls, href, label, sr) =>
    `<a class="btn ${cls}" href="${esc(href)}" target="_blank" rel="noopener">${label}<span class="sr">: ${esc(sr)}</span></a>`;
  const action = !complete
    ? link('primary', nextStringUrl(e), `${t('card.translate')} ${arrow}`, name)
    : !allApproved
      ? link('', nextStringUrl(e), `${t('card.review')} ${arrow}`, name)
      : link('', e.webUrl, t('card.open', { platform }), name);
  const days = Math.floor(daysSince(e.lastChange));
  return `
    <article class="card entry${complete ? ' done' : ''}">
      <header class="entry-head">
        <div class="tags">
          <span class="tag platform" data-platform="${esc(e.platform || 'weblate')}" title="${t('card.platform', { platform })}">${esc(platformLabel(e))}</span>
          ${e.pinned ? `<span class="tag pin" title="${t('card.pinnedHint')}">★ ${t('card.pinned')}</span>` : ''}
          ${complete ? `<span class="tag ok">✓ ${t('card.complete')}</span>` : ''}
          ${stale ? `<span class="tag stale" title="${t('card.staleHint', { count: days })}">◷ ${t('card.stale')}</span>` : ''}
        </div>
        <p class="project"><a href="${esc(e.project.url)}" target="_blank" rel="noopener">${esc(e.project.name)}</a></p>
        <h3><a href="${esc(e.webUrl)}" target="_blank" rel="noopener">${esc(e.component.name)}</a></h3>
      </header>
      ${bar(e.translatedPercent, 'translated', t('card.translated'))}
      ${e.review ? bar(e.approvedPercent, 'approved', t('card.approved')) : ''}
      <p class="left">${left.length ? left.join(' · ') : t('card.allDone', { count: e.total })}</p>
      <footer class="entry-foot">
        <p class="activity">
          ${e.lastChange ? `<span title="${esc(fullDate(e.lastChange))}">${t('card.lastActivity', { when: ago(e.lastChange) })}</span>` : ''}
          ${e.lastContribution ? `<span title="${esc(fullDate(e.lastContribution))}">${t(state.config.team.enabled ? 'card.team' : 'card.you', { when: ago(e.lastContribution) })}</span>` : ''}
        </p>
        ${action}
      </footer>
    </article>`;
}

/* ---------- badges ---------- */

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
      <button class="btn small" type="button" data-copy="${esc(snippet(alt, file))}">${t('badges.copy')}<span class="sr">: ${esc(alt)}</span></button>
    </li>`;
  const groups = groupByProject(entries).sort((a, b) =>
    a.project.name.localeCompare(b.project.name),
  );
  return `
    <section class="badges card" aria-labelledby="badges-title">
      <h2 id="badges-title">${t('badges.title')}</h2>
      <p class="muted">${t('badges.text')}
        <a href="${pageUrl('stats')}#card" data-nav="stats">${t('badges.cardLink')}</a></p>
      <ul class="badge-list">
        ${row(overallBadge({ label, stats }), `${lang} translation progress`, 'overall.svg')}
      </ul>
      <details>
        <summary>${t('badges.perProject', { count: groups.length })}</summary>
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
    if (!instances.some((i) => i.url === p.url && i.platform === 'weblate')) {
      instances.push({ ...p, platform: 'weblate', usernames: [], pinned: [], enabled: false });
    }
  }
  const own = (inst) =>
    inst.usernames.join(', ') === cfg.usernames.join(', ') ? '' : inst.usernames.join(', ');
  const text = (name, value, placeholder, label) => `
    <label class="field"><span>${label}</span>
      <input name="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" autocapitalize="off" spellcheck="false" /></label>`;
  const row = (inst) => {
    const adapter = getPlatform(inst.platform);
    const isWeblate = inst.platform === 'weblate';
    const tokenLabel = adapter.tokenRequired ? t('settings.tokenRequired') : t('settings.token');
    return `
    <fieldset class="inst" data-id="${esc(inst.id)}" data-url="${esc(inst.url)}" data-name="${esc(inst.name)}" data-platform="${esc(inst.platform)}">
      <label class="check">
        <input type="checkbox" name="enabled" ${inst.enabled ? 'checked' : ''} />
        <span><strong>${esc(inst.name)}</strong> <span class="muted">${esc(isWeblate ? inst.url.replace(/^https?:\/\//, '') : t(`platform.${inst.platform}`))}</span></span>
      </label>
      <div class="inst-fields">
        ${
          isWeblate
            ? text('usernames', own(inst), tt('settings.sameAsAbove'), t('settings.usernameHere')) +
              text(
                'pinned',
                inst.pinned.join(', '),
                'project/component, project',
                t('settings.pinned'),
              )
            : text(
                'pinned',
                inst.pinned.join(', '),
                tt(`settings.projectsHint.${inst.platform}`),
                t('settings.projects'),
              ) +
              text(
                'language',
                inst.language,
                adapter.languageCode(cfg.language || 'pt_BR'),
                t('settings.languageHere'),
              )
        }
        ${
          isWeblate || adapter.tokenRequired
            ? `<label class="field"><span>${tokenLabel}</span>
          <input name="token" type="password" value="${esc(tokens[inst.id] || '')}" placeholder="${isWeblate ? 'wlu_…' : ''}" autocomplete="off" />
          ${adapter.tokenRequired ? `<small class="muted">${esc(adapter.tokenHint)}</small>` : ''}</label>`
            : ''
        }
      </div>
    </fieldset>`;
  };
  const others = Object.keys(PLATFORM_META).filter((id) => id !== 'weblate');
  $('#settings').innerHTML = `
    <form method="dialog" id="settings-form">
      <header class="dialog-head">
        <h2 id="settings-title">${t('shell.settings')}</h2>
        <button class="btn icon" type="button" data-action="close-settings" aria-label="${t('settings.close')}">✕</button>
      </header>
      <div class="dialog-body">
        <div class="pair">
          <label class="field"><span>${t('settings.language')}</span>
            <input name="language" value="${esc(cfg.language)}" placeholder="sq" required autocomplete="off" autocapitalize="off" spellcheck="false" /></label>
          <label class="field"><span>${t('settings.usernames')}</span>
            <input name="usernames" value="${esc(cfg.usernames.join(', '))}" placeholder="alice, alice_b" autocomplete="off" autocapitalize="off" spellcheck="false" /></label>
        </div>
        <h3>${t('settings.instances')}</h3>
        <div id="inst-list">${instances.map(row).join('')}</div>
        <div class="add-inst">
          <label class="field"><span>${t('settings.addWeblate')}</span>
            <input id="new-url" type="url" placeholder="https://weblate.example.org" autocomplete="off" /></label>
          <button class="btn" type="button" data-action="add-instance">${t('settings.add')}</button>
        </div>
        <div class="add-inst">
          <label class="field"><span>${t('settings.addPlatform')}</span>
            <select id="new-platform">
              ${others.map((id) => `<option value="${id}">${esc(PLATFORM_META[id].name)}</option>`).join('')}
            </select></label>
          <button class="btn" type="button" data-action="add-platform">${t('settings.add')}</button>
        </div>
        <h3>${t('settings.interface')}</h3>
        <label class="field"><span>${t('settings.uiLanguage')}</span>
          <select name="locale">
            ${Object.entries(state.locales)
              .map(
                ([code, name]) =>
                  `<option value="${esc(code)}"${code === currentLocale() ? ' selected' : ''}>${esc(name)}</option>`,
              )
              .join('')}
          </select></label>
        <p class="muted small">${t('settings.note')}</p>
      </div>
      <footer class="dialog-foot">
        <button class="btn" type="button" data-action="copy-config">${t('settings.copy')}</button>
        ${state.overridden ? `<button class="btn" type="button" data-action="reset-settings">${t('settings.reset')}</button>` : ''}
        <span class="spacer"></span>
        <button class="btn primary" type="submit">${t('settings.save')}</button>
      </footer>
    </form>`;
}

/** Read the settings form into a raw config object + tokens. */
function readSettings() {
  const form = $('#settings-form');
  const split = (v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const tokens = {};
  const instances = $$('.inst', form).map((el) => {
    const get = (name) => el.querySelector(`[name="${name}"]`);
    const { id, platform } = el.dataset;
    if (get('token')?.value.trim()) tokens[id] = get('token').value.trim();
    const off = get('enabled').checked ? {} : { enabled: false };
    if (platform !== 'weblate') {
      const language = get('language').value.trim();
      return {
        platform,
        ...(id === platform ? {} : { id }),
        // Self-hosted or proxied installations keep their address.
        ...(el.dataset.url === PLATFORM_META[platform].url ? {} : { url: el.dataset.url }),
        projects: split(get('pinned').value),
        ...(language ? { language } : {}),
        ...off,
      };
    }
    const preset = PRESETS.find((p) => p.id === id && p.url === el.dataset.url);
    return {
      id,
      ...(preset ? {} : { name: el.dataset.name, url: el.dataset.url }),
      usernames: split(get('usernames').value),
      pinned: split(get('pinned').value),
      ...off,
    };
  });
  const base = state.overridden ? load('settings', {}) : state.repoConfig;
  const raw = {
    ...base,
    // Instance rows have a field called "language" too: ask for the first one.
    language: form.querySelector('.pair [name="language"]').value.trim(),
    usernames: split(form.querySelector('.pair [name="usernames"]').value),
    instances,
  };
  return { raw, tokens, locale: form.elements.locale.value };
}

function openSettings() {
  renderSettings();
  const dialog = $('#settings');
  if (!dialog.open) dialog.showModal();
}

/** Re-render the open settings form with `raw`, keeping what was typed. */
function redrawSettings(raw, tokens) {
  const current = state.config;
  state.config = normalizeConfig(raw);
  save('tokens', { ...load('tokens', {}), ...tokens });
  renderSettings();
  state.config = current;
}

async function applySettings() {
  const { raw, tokens, locale } = readSettings();
  save('settings', raw);
  save('tokens', tokens);
  state.overridden = true;
  state.config = normalizeConfig(raw);
  if (locale !== currentLocale()) {
    state.prefs.locale = locale;
    savePrefs();
    await loadLocale();
    renderShell();
  }
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
  const showOffline = () => {
    $('#offline').hidden = navigator.onLine !== false;
    $('#offline').textContent = tt('shell.offline');
  };
  addEventListener('online', () => {
    showOffline();
    refresh({ force: false });
  });
  addEventListener('offline', showOffline);
  showOffline();
  addEventListener('popstate', () => {
    state.view = viewFromUrl();
    render();
  });

  document.addEventListener('click', async (ev) => {
    const nav = ev.target.closest('a[data-nav]');
    if (nav && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && ev.button === 0) {
      ev.preventDefault();
      const url = new URL(nav.href);
      history.pushState(null, '', url.search + url.hash || './');
      state.view = viewFromUrl();
      await render();
      const target = url.hash && document.getElementById(url.hash.slice(1));
      if (target) target.scrollIntoView();
      else scrollTo(0, 0);
      app.focus({ preventScroll: true });
      return;
    }
    const el = ev.target.closest('[data-action],[data-copy],[data-instance],[data-toggle]');
    if (!el) return;
    if (el.dataset.copy !== undefined) {
      copyText(el.dataset.copy);
    } else if (el.dataset.instance) {
      state.prefs.instance = el.dataset.instance;
      savePrefs();
      $$('[data-instance]', el.parentElement).forEach((c) =>
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
      copyText(`${JSON.stringify(raw, null, 2)}\n`, tt('toast.configCopied'));
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
        toast(tt('toast.badAddress'));
        return;
      }
      const { raw, tokens } = readSettings();
      if (!normalizeConfig(raw).instances.some((i) => i.url === url)) {
        raw.instances.push({ url, usernames: [], pinned: [] });
      }
      redrawSettings(raw, tokens);
    } else if (el.dataset.action === 'add-platform') {
      const platform = $('#new-platform').value;
      const { raw, tokens } = readSettings();
      if (normalizeConfig(raw).instances.some((i) => i.platform === platform)) {
        toast(tt('toast.platformExists', { platform: PLATFORM_META[platform].name }));
        return;
      }
      raw.instances.push({ platform, projects: [] });
      redrawSettings(raw, tokens);
      $(`.inst[data-platform="${platform}"] [name="pinned"]`)?.focus();
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
