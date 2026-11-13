// Year in review: animated summary of one year, and a share image.

import { currentLocale, t, tt } from '../i18n.js';
import { historyDays } from '../stats.js';
import { $, $$, download, esc, num, shortDate, svgUri, toast } from '../ui.js';
import { SHARE_SIZES, shareImage, wrappedStats, yearsWithData } from '../wrapped.js';
import { emptyState, notConfigured, pageHead, projectNames } from './common.js';

const view = { size: 'wide', theme: 'light' };

const monthLabel = (ym, style = 'long') =>
  ym
    ? new Date(`${ym}-01T00:00:00Z`).toLocaleDateString(currentLocale().replace(/_/g, '-'), {
        month: style,
        timeZone: 'UTC',
      })
    : '';

function labels(ctx, stats) {
  return {
    title: tt('wrapped.shareTitle', { language: ctx.languageName(), year: String(stats.year) }),
    contributions: tt('wrapped.contributions'),
    activeDays: tt('wrapped.activeDays'),
    streak: tt('wrapped.streakShort'),
    busiest: tt('wrapped.busiestMonth'),
    top: tt('wrapped.topProjects'),
    footer: ctx.config.team.name || ctx.config.displayName || ctx.config.usernames[0] || '',
  };
}

const image = (ctx, stats) =>
  shareImage(stats, {
    size: view.size,
    theme: view.theme,
    labels: labels(ctx, stats),
    monthName: monthLabel(stats.busiestMonth),
  });

function share(ctx, stats) {
  const [w, h] = SHARE_SIZES[view.size];
  const chip = (group, value, label) =>
    `<button type="button" class="chip" data-${group}="${value}" aria-pressed="${view[group] === value}">${label}</button>`;
  return `
    <div class="chips" role="group" aria-label="${t('wrapped.format')}">
      ${chip('size', 'wide', t('wrapped.wide'))}${chip('size', 'square', t('wrapped.square'))}
      <span class="divider"></span>
      ${chip('theme', 'light', t('card.light'))}${chip('theme', 'dark', t('card.dark'))}
    </div>
    <img class="share-preview" src="${svgUri(image(ctx, stats))}" width="${w}" height="${h}" alt="${t('wrapped.imageAlt', { year: String(stats.year), count: stats.contributions })}" />
    <div class="row">
      <button class="btn primary" type="button" data-download="png">${t('wrapped.png', { size: `${w}×${h}` })}</button>
      <button class="btn" type="button" data-download="svg">${t('wrapped.svg')}</button>
    </div>`;
}

let current = null;

export async function render(ctx) {
  if (!ctx.configured()) return pageHead(t('nav.wrapped')) + notConfigured(ctx);
  const [activity, index] = await Promise.all([ctx.file('activity'), ctx.file('history/index')]);
  const files = await Promise.all((index?.years || []).map((y) => ctx.file(`history/${y}`)));
  const points = historyDays(files.filter(Boolean));
  const years = yearsWithData(activity, points);
  if (!years.length) {
    return pageHead(t('nav.wrapped')) + emptyState(t('wrapped.empty'), t('wrapped.emptyText'));
  }
  const asked = Number(ctx.query.get('year'));
  const year = years.includes(asked) ? asked : years[0];
  const stats = wrappedStats({ activity, points, names: projectNames(ctx.entries()), year });
  current = stats;
  const max = Math.max(1, ...stats.months);
  const big = (value, label, note = '') => `
    <li class="wrap-card">
      <span class="wrap-number" data-count="${value}">${num(value)}</span>
      <span class="wrap-label">${label}</span>
      ${note ? `<span class="muted small">${note}</span>` : ''}
    </li>`;

  return `
    ${pageHead(t('wrapped.title', { year: String(year) }), t('wrapped.intro', { language: ctx.languageName() }))}
    ${
      years.length > 1
        ? `<nav class="chips" aria-label="${t('wrapped.years')}">${years
            .map(
              (y) =>
                `<a class="chip" href="${ctx.pageUrl('wrapped', { year: y })}" data-nav="wrapped"${y === year ? ' aria-current="page"' : ''}>${y}</a>`,
            )
            .join('')}</nav>`
        : ''
    }
    ${
      stats.contributions === 0
        ? `<p class="notice info">${t('wrapped.noActivity', { year: String(year) })}</p>`
        : ''
    }
    <ul class="wrap-grid">
      ${big(stats.contributions, t('wrapped.contributions'), t('wrapped.inProjects', { count: stats.projects }))}
      ${big(stats.activeDays, t('wrapped.activeDays'))}
      ${big(stats.longestStreak, t('wrapped.streak'), stats.streakEnd ? `${esc(shortDate(stats.streakStart, { month: 'short', day: 'numeric' }))} – ${esc(shortDate(stats.streakEnd, { month: 'short', day: 'numeric' }))}` : '')}
      <li class="wrap-card">
        <span class="wrap-number text">${esc(monthLabel(stats.busiestMonth)) || '–'}</span>
        <span class="wrap-label">${t('wrapped.busiestMonth')}</span>
        ${stats.busiestMonth ? `<span class="muted small">${t('stats.dayCount', { count: stats.busiestMonthCount })}</span>` : ''}
      </li>
      ${stats.stringsGained !== null && stats.stringsGained > 0 ? big(stats.stringsGained, t('wrapped.gained'), t('wrapped.fromTo', { from: stats.percentStart, to: stats.percentEnd })) : ''}
      ${stats.completed.length ? big(stats.completed.length, t('wrapped.completed', { count: stats.completed.length }), esc(stats.completed.slice(0, 4).join(', '))) : ''}
    </ul>

    <section class="card block" aria-labelledby="wrap-months">
      <h2 id="wrap-months">${t('wrapped.byMonth')}</h2>
      <ol class="month-bars" aria-label="${t('wrapped.byMonth')}">
        ${stats.months
          .map((n, i) => {
            const ym = `${year}-${String(i + 1).padStart(2, '0')}`;
            return `<li title="${esc(monthLabel(ym))}: ${num(n)}"><span class="month-bar" style="--h:${(n / max) * 100}%"></span>
              <span class="month-name" aria-hidden="true">${esc(monthLabel(ym, 'narrow'))}</span>
              <span class="sr">${esc(monthLabel(ym))}: ${t('stats.dayCount', { count: n })}</span></li>`;
          })
          .join('')}
      </ol>
      ${stats.busiestDay ? `<p class="muted">${t('wrapped.busiestDay', { day: shortDate(stats.busiestDay, { dateStyle: 'long' }), count: stats.busiestDayCount })}</p>` : ''}
    </section>

    ${
      stats.topProjects.length
        ? `<section class="card block" aria-labelledby="wrap-top">
      <h2 id="wrap-top">${t('wrapped.topProjects')}</h2>
      <ol class="top-list">${stats.topProjects
        .map(
          (p) =>
            `<li><span>${esc(p.name)}</span><span class="mini-meter"><span class="bar" aria-hidden="true"><span style="width:${(p.changes / stats.topProjects[0].changes) * 100}%"></span></span><span>${num(p.changes)}</span></span></li>`,
        )
        .join('')}</ol>
    </section>`
        : ''
    }

    <section class="card block" aria-labelledby="wrap-share">
      <h2 id="wrap-share">${t('wrapped.share')}</h2>
      <p class="muted">${t('wrapped.shareText')}</p>
      <div id="wrap-share-box">${share(ctx, stats)}</div>
    </section>`;
}

/** Draw the SVG on a canvas and hand back a PNG. */
async function toPng(svg, [width, height]) {
  const img = new Image();
  img.decoding = 'async';
  img.src = svgUri(svg);
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('canvas export failed');
  return blob;
}

/** Count each number up from zero, unless the visitor prefers no motion. */
function animate(root) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  root.classList.add('animated');
  const duration = 900;
  const start = performance.now();
  const numbers = $$('[data-count]', root).map((el) => [el, Number(el.dataset.count)]);
  const tick = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - progress) ** 3;
    for (const [el, target] of numbers) el.textContent = num(Math.round(target * eased));
    if (progress < 1 && root.isConnected) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function bind(root, ctx) {
  animate(root);
  root.addEventListener('click', async (ev) => {
    const el = ev.target.closest('[data-size],[data-theme],[data-download]');
    if (!el || !current) return;
    if (el.dataset.download) {
      const name = `tallyglot-${current.year}-${view.size}`;
      const svg = image(ctx, current);
      try {
        if (el.dataset.download === 'svg') download(`${name}.svg`, svg, 'image/svg+xml');
        else download(`${name}.png`, await toPng(svg, SHARE_SIZES[view.size]));
        toast(tt('wrapped.saved'));
      } catch {
        toast(tt('wrapped.pngFailed'));
      }
      return;
    }
    const group = el.dataset.size ? 'size' : 'theme';
    view[group] = el.dataset[group];
    $('#wrap-share-box', root).innerHTML = share(ctx, current);
    $(`[data-${group}="${view[group]}"]`, root)?.focus();
  });
}
