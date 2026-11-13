// Find work: projects with little or no coverage in the user's language.

import { emptyIndex, rankProjects, scanInstance, FIND_SORTS } from '../findwork.js';
import { t, tt } from '../i18n.js';
import { clientFor, getPlatform } from '../platforms/index.js';
import { PLATFORM_META } from '../presets.js';
import { load, save } from '../store.js';
import { $, esc, num, toast } from '../ui.js';
import { notConfigured, pageHead } from './common.js';

const PAGE = 50;
const view = {
  query: '',
  max: null, // starts at findWork.maxPercent from the config
  sort: 'popular',
  instance: 'all',
  hideTracked: true,
  shown: PAGE,
};
let index = null;
let busy = false;

/** The Action's index, plus whatever this browser has read on top of it. */
async function loadIndex(ctx) {
  const committed = (await ctx.file('findwork')) || emptyIndex(ctx.config.language);
  const local = ctx.demo ? null : load('findwork', null);
  if (!local || local.language !== ctx.config.language) return structuredClone(committed);
  const merged = structuredClone(committed);
  for (const [key, p] of Object.entries(local.projects || {})) {
    if (!merged.projects[key] || (p.scannedAt || '') > (merged.projects[key].scannedAt || '')) {
      merged.projects[key] = p;
    }
  }
  for (const [id, source] of Object.entries(local.sources || {})) {
    if ((source.updatedAt || '') > (merged.sources[id]?.updatedAt || ''))
      merged.sources[id] = source;
  }
  return merged;
}

const tracked = (ctx) => new Set(ctx.entries().map((e) => `${e.instance}:${e.project.slug}`));

function results(ctx) {
  const list = rankProjects(index, {
    maxPercent: view.max,
    tracked: view.hideTracked ? tracked(ctx) : new Set(),
    query: view.query,
    instance: view.instance,
    sort: view.sort,
  });
  if (!list.length) return `<p class="none">${t('find.none')}</p>`;
  const rows = list
    .slice(0, view.shown)
    .map((p) => {
      const platform = PLATFORM_META[p.platform || 'weblate'].name;
      return `
      <tr>
        <th scope="row" class="wrap">
          <a href="${esc(p.url)}" target="_blank" rel="noopener" title="${t('find.startHint', { name: p.name, platform })}">${esc(p.name)}</a>
          ${p.web ? `<a class="muted small" href="${esc(p.web)}" target="_blank" rel="noopener">${t('find.source')}</a>` : ''}
        </th>
        <td><span class="tag platform" data-platform="${esc(p.platform || 'weblate')}">${esc(ctx.instanceName(p.instance))}</span></td>
        <td>
          <div class="mini-meter"><div class="bar" role="img" aria-label="${p.percent}%"><span style="width:${Math.min(100, p.percent)}%"></span></div>
          <span>${p.started ? `${p.percent}%` : t('find.notStarted')}</span></div>
        </td>
        <td class="num">${num(Math.max(0, p.total - p.translated))}</td>
        <td class="num">${p.stars === null || p.stars === undefined ? `<span class="muted" title="${t('find.starsUnknown')}">–</span>` : `★ ${num(p.stars)}`}</td>
        <td class="num">${num(p.languages || 0)}</td>
      </tr>`;
    })
    .join('');
  return `
    <p class="muted small" role="status">${t('find.results', { count: list.length })}${list.length > view.shown ? ` ${t('find.showing', { count: view.shown })}` : ''}</p>
    <div class="table-wrap tall"><table class="find-table">
      <thead><tr>
        <th>${t('find.col.project')}</th><th>${t('find.col.platform')}</th><th>${t('find.col.coverage')}</th>
        <th class="num">${t('find.col.left')}</th><th class="num">${t('find.col.stars')}</th><th class="num">${t('find.col.languages')}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${list.length > view.shown ? `<div class="row"><button class="btn" type="button" data-more>${t('find.more')}</button></div>` : ''}`;
}

function sources(ctx) {
  const rows = ctx.activeInstances().map((inst) => {
    const adapter = getPlatform(inst.platform);
    if (!adapter.catalog) return null;
    const s = index.sources[inst.id] || { scanned: 0 };
    const state = s.complete
      ? t('find.indexRowAll', { scanned: s.scanned })
      : s.total
        ? t('find.indexRow', { scanned: s.scanned, total: s.total })
        : t('find.indexRowUnknown', { scanned: s.scanned || 0 });
    const live = adapter.browser !== false && !ctx.demo;
    return `<li><strong>${esc(inst.name)}</strong> <span class="muted">${state}${s.error ? ` · ${t('find.indexError', { error: s.error })}` : ''}</span>
      ${live && !s.complete ? `<button class="btn small" type="button" data-scan="${esc(inst.id)}"${busy ? ' disabled' : ''}>${busy ? t('find.scanning') : t('find.scan')}</button>` : ''}</li>`;
  });
  const unsupported = ctx
    .activeInstances()
    .filter((i) => !getPlatform(i.platform).catalog)
    .map((i) => i.name);
  return `
    <ul class="source-list">${rows.filter(Boolean).join('')}</ul>
    <p class="muted small">${t('find.indexText')}</p>
    ${unsupported.length ? `<p class="muted small">${t('find.unsupported', { platforms: [...new Set(unsupported)].join(', ') })}</p>` : ''}`;
}

export async function render(ctx) {
  const language = ctx.languageName();
  if (!ctx.configured()) return pageHead(t('find.title', { language: '…' })) + notConfigured(ctx);
  index = await loadIndex(ctx);
  view.max ??= ctx.config.findWork.maxPercent;
  const instances = [...new Set(Object.values(index.projects).map((p) => p.instance))];
  if (view.instance !== 'all' && !instances.includes(view.instance)) view.instance = 'all';
  const option = (value, label, current) =>
    `<option value="${esc(value)}"${String(value) === String(current) ? ' selected' : ''}>${esc(label)}</option>`;
  const empty = !Object.keys(index.projects).length;
  return `
    ${pageHead(t('find.title', { language }), t('find.intro', { language }))}
    ${
      empty
        ? `<section class="welcome card"><h2>${t('find.empty')}</h2><p>${t('find.emptyText')}</p></section>`
        : `<section class="toolbar" aria-label="${t('toolbar.label')}">
      <div class="toolbar-row">
        <label class="field search"><span class="sr">${t('find.search')}</span>
          <input id="find-query" type="search" placeholder="${t('find.searchHint')}" value="${esc(view.query)}" autocomplete="off" /></label>
        <label class="field"><span>${t('find.coverage')}</span>
          <select id="find-max">
            ${option(0, tt('find.coverage0'), view.max)}
            ${[...new Set([25, 50, 80, view.max])]
              .filter((n) => n > 0 && n < 100)
              .sort((a, b) => a - b)
              .map((n) => option(n, tt('find.coverageUpTo', { percent: n }), view.max))
              .join('')}
            ${option(100, tt('find.coverageAny'), view.max)}
          </select></label>
        <label class="field"><span>${t('find.sort')}</span>
          <select id="find-sort">${Object.keys(FIND_SORTS)
            .map((k) => option(k, tt(`find.sorts.${k}`), view.sort))
            .join('')}</select></label>
      </div>
      <div class="chips" role="group" aria-label="${t('toolbar.filters')}">
        ${
          instances.length > 1
            ? [['all', tt('find.all')], ...instances.map((id) => [id, ctx.instanceName(id)])]
                .map(
                  ([id, label]) =>
                    `<button type="button" class="chip" data-find-instance="${esc(id)}" aria-pressed="${view.instance === id}">${esc(label)}</button>`,
                )
                .join('') + '<span class="divider"></span>'
            : ''
        }
        <button type="button" class="chip" data-hide-tracked aria-pressed="${view.hideTracked}">${t('find.hideTracked')}</button>
      </div>
    </section>
    <section id="find-results">${results(ctx)}</section>`
    }
    <section class="card block" aria-labelledby="find-index">
      <h2 id="find-index">${t('find.indexTitle')}</h2>
      <div id="find-sources">${sources(ctx)}</div>
    </section>`;
}

export function bind(root, ctx) {
  const redraw = () => {
    const el = $('#find-results', root);
    if (el) el.innerHTML = results(ctx);
  };
  root.addEventListener('input', (ev) => {
    if (ev.target.id !== 'find-query') return;
    view.query = ev.target.value;
    view.shown = PAGE;
    redraw();
  });
  root.addEventListener('change', (ev) => {
    if (ev.target.id === 'find-max') view.max = Number(ev.target.value);
    else if (ev.target.id === 'find-sort') view.sort = ev.target.value;
    else return;
    view.shown = PAGE;
    redraw();
  });
  root.addEventListener('click', async (ev) => {
    const el = ev.target.closest(
      '[data-find-instance],[data-hide-tracked],[data-more],[data-scan]',
    );
    if (!el) return;
    if (el.dataset.findInstance) {
      view.instance = el.dataset.findInstance;
      for (const chip of root.querySelectorAll('[data-find-instance]')) {
        chip.setAttribute('aria-pressed', String(chip === el));
      }
    } else if ('hideTracked' in el.dataset) {
      view.hideTracked = !view.hideTracked;
      el.setAttribute('aria-pressed', String(view.hideTracked));
    } else if ('more' in el.dataset) {
      view.shown += PAGE;
    } else if (el.dataset.scan && !busy) {
      const inst = ctx.activeInstances().find((i) => i.id === el.dataset.scan);
      busy = true;
      $('#find-sources', root).innerHTML = sources(ctx);
      const found = await scanInstance(
        index,
        inst,
        clientFor(inst, { token: ctx.tokens()[inst.id] }),
        {
          language: ctx.config.language,
          budget: 12,
        },
      );
      busy = false;
      save('findwork', index);
      toast(found ? tt('find.scanDone', { count: found }) : tt('find.scanNone'));
      // The first projects turn the empty state into the full page.
      if (found && !$('#find-results', root)) {
        ctx.navigate('find', {}, { replace: true });
        return;
      }
      $('#find-sources', root).innerHTML = sources(ctx);
      $(`[data-scan="${inst.id}"]`, root)?.focus();
    }
    redraw();
  });
}
