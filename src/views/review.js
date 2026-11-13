// Review queue: failing checks, pending suggestions, strings marked for
// editing and comments, for every component on every platform.

import { NetworkError, RateLimitError } from '../api.js';
import { t, tt } from '../i18n.js';
import { clientFor } from '../platforms/index.js';
import { REVIEW_KINDS, canListStrings, loadStrings, reviewItems, reviewTotals } from '../review.js';
import { $, ago, esc, num, siteUrl } from '../ui.js';
import { notConfigured, pageHead, tile } from './common.js';

const PAGE = 30;
const view = { kind: 'all', shown: PAGE };
const open = new Map(); // item id -> { strings, more } | { error } | 'loading'

function strings(item) {
  const state = open.get(item.id);
  if (!state) return '';
  if (state === 'loading') return `<p class="muted small" role="status">${t('shell.loading')}</p>`;
  if (state.error) return `<p class="notice warn small">${esc(state.error)}</p>`;
  if (!state.strings.length) return `<p class="muted small">${t('review.noneNow')}</p>`;
  return `
    <ul class="strings">${state.strings
      .map(
        (s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">
          <span class="string-source">${esc(s.source) || `<em>${t('review.emptyString')}</em>`}</span>
          <span class="string-target muted">${esc(s.target) || `<em>${t('review.untranslated')}</em>`}</span></a></li>`,
      )
      .join('')}</ul>
    ${state.more ? `<p class="muted small">${t('review.moreStrings', { count: state.more })} <a href="${esc(item.url)}" target="_blank" rel="noopener">${t('review.openAll')}</a></p>` : ''}`;
}

function row(ctx, item) {
  const e = item.entry;
  const expanded = open.has(item.id);
  return `
    <li class="card queue-item" data-item="${esc(item.id)}">
      <div class="queue-head">
        <div>
          <p class="project">${esc(e.project.name)}</p>
          <h3>${esc(e.component.name)}</h3>
        </div>
        <span class="tag platform" data-platform="${esc(e.platform || 'weblate')}">${esc(ctx.instanceName(e.instance))}</span>
      </div>
      <p class="queue-count"><strong>${num(item.count)}</strong> ${t(`review.kind.${item.kind}`, { count: item.count })}</p>
      <div class="row">
        <a class="btn primary small" href="${esc(item.url)}" target="_blank" rel="noopener">${t('review.open')} <span aria-hidden="true">→</span><span class="sr">: ${esc(e.project.name)} – ${esc(e.component.name)}</span></a>
        ${
          canListStrings(e) && !ctx.demo
            ? `<button class="btn small" type="button" data-strings="${esc(item.id)}" aria-expanded="${expanded}">${expanded ? t('review.hide') : t('review.show')}</button>`
            : ''
        }
      </div>
      <div class="queue-strings">${strings(item)}</div>
    </li>`;
}

function queue(ctx) {
  const items = reviewItems(ctx.entries(), view.kind === 'all' ? REVIEW_KINDS : [view.kind]);
  if (!items.length) return `<p class="none">${t('review.clear')}</p>`;
  return `
    <p class="muted small" role="status">${t('review.count', { count: items.length })}</p>
    <ul class="queue">${items
      .slice(0, view.shown)
      .map((i) => row(ctx, i))
      .join('')}</ul>
    ${items.length > view.shown ? `<div class="row"><button class="btn" type="button" data-more>${t('find.more')}</button></div>` : ''}`;
}

export async function render(ctx) {
  if (!ctx.configured()) return pageHead(t('nav.review')) + notConfigured(ctx);
  const totals = reviewTotals(ctx.entries());
  const alerts = ((await ctx.file('alerts'))?.events || []).slice(0, 8);
  const all = Object.values(totals).reduce((a, b) => a + b, 0);
  const chip = (kind, label, count) =>
    `<button type="button" class="chip" data-kind="${kind}" aria-pressed="${view.kind === kind}">${label} <span class="count">${num(count)}</span></button>`;
  return `
    ${pageHead(t('review.title'), t('review.intro'))}
    <section class="tiles stats-tiles">
      ${REVIEW_KINDS.map((kind) => tile(num(totals[kind]), t(`review.tile.${kind}`))).join('')}
    </section>
    <section class="toolbar" aria-label="${t('toolbar.filters')}">
      <div class="chips" role="group" aria-label="${t('toolbar.filters')}">
        ${chip('all', t('review.all'), all)}
        ${REVIEW_KINDS.map((kind) => chip(kind, t(`review.tile.${kind}`), totals[kind])).join('')}
      </div>
    </section>
    <section id="queue">${queue(ctx)}</section>
    <section class="card block" aria-labelledby="new-strings">
      <div class="block-head">
        <h2 id="new-strings">${t('review.newStrings')}</h2>
        <a class="btn small" href="${esc(`${siteUrl()}feed.xml`)}">${t('review.rss')}</a>
      </div>
      ${
        alerts.length
          ? `<ol class="timeline wide">${alerts
              .map(
                (a) =>
                  `<li><time datetime="${esc(a.at)}">${esc(ago(a.at))}</time><span><a href="${esc(a.url)}" target="_blank" rel="noopener"><strong>${esc(a.name)}</strong></a> ${t('review.added', { count: a.added })} <span class="muted">${t('review.waiting', { count: a.waiting })}</span></span></li>`,
              )
              .join('')}</ol>`
          : `<p class="muted">${t('review.newStringsEmpty')}</p>`
      }
    </section>
    <p class="muted small">${t('review.tokens', { settings: { html: `<button class="link" data-action="settings" type="button">${t('shell.settings')}</button>` } })}</p>`;
}

export function bind(root, ctx) {
  const redraw = () => {
    $('#queue', root).innerHTML = queue(ctx);
  };
  root.addEventListener('click', async (ev) => {
    const el = ev.target.closest('[data-kind],[data-more],[data-strings]');
    if (!el) return;
    if (el.dataset.kind) {
      view.kind = el.dataset.kind;
      view.shown = PAGE;
      for (const chip of root.querySelectorAll('[data-kind]')) {
        chip.setAttribute('aria-pressed', String(chip === el));
      }
      redraw();
    } else if ('more' in el.dataset) {
      view.shown += PAGE;
      redraw();
    } else if (el.dataset.strings) {
      const id = el.dataset.strings;
      const refocus = () => root.querySelector(`[data-strings="${CSS.escape(id)}"]`)?.focus();
      if (open.has(id)) {
        open.delete(id);
        redraw();
        refocus();
        return;
      }
      const item = reviewItems(ctx.entries()).find((i) => i.id === id);
      const inst = ctx.config.instances.find((i) => i.id === item.entry.instance);
      open.set(id, 'loading');
      redraw();
      refocus();
      try {
        const client = clientFor(inst, { token: ctx.tokens()[inst.id] });
        open.set(id, await loadStrings(client, item));
      } catch (err) {
        open.set(id, {
          error:
            err instanceof RateLimitError
              ? tt('review.error.limit')
              : err instanceof NetworkError
                ? tt('review.error.network', { name: inst.name })
                : err.message,
        });
      }
      if (root.isConnected) {
        redraw();
        refocus();
      }
    }
  });
}
