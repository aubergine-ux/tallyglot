// Translator portfolio: a page to link from a CV, printable as PDF and
// exportable as JSON Resume.

import { lineChart } from '../charts.js';
import { t, tt } from '../i18n.js';
import { portfolioData, toJsonResume } from '../portfolio.js';
import { historyDays, series } from '../stats.js';
import { copyText, download, esc, num, shortDate, siteUrl } from '../ui.js';
import { notConfigured, pageHead } from './common.js';
import { achievementText } from './profile.js';

let data = null;

const initials = (name) =>
  name
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

export async function render(ctx) {
  if (!ctx.configured()) return pageHead(t('nav.portfolio')) + notConfigured(ctx);
  const [activity, index] = await Promise.all([ctx.file('activity'), ctx.file('history/index')]);
  const files = await Promise.all((index?.years || []).map((y) => ctx.file(`history/${y}`)));
  const points = series(historyDays(files.filter(Boolean)));
  data = portfolioData({
    entries: ctx.entries(),
    activity,
    config: ctx.config,
    languageName: ctx.languageName(),
  });
  const chart =
    points.length > 1
      ? lineChart(points, {
          width: Math.max(300, Math.min(1090, document.documentElement.clientWidth - 74)),
          height: 220,
          label: tt('stats.chart.label', {
            name: tt('stats.chart.overall'),
            from: points[0].percent,
            to: points[points.length - 1].percent,
          }),
          formatDay: (d) => shortDate(d),
        })
      : null;
  const stat = (value, label) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  return `
    <header class="portfolio-head">
      <p class="eyebrow">${data.team ? t('portfolio.team') : t('portfolio.translator')}</p>
      <h1>${esc(data.name) || t('nav.portfolio')}</h1>
      <p class="portfolio-langs">${data.languages.map((l) => `<span class="tag">${esc(l.name)}</span>`).join(' ')}
        ${data.since ? `<span class="muted">${t('portfolio.since', { date: shortDate(data.since, { month: 'long', year: 'numeric' }) })}</span>` : ''}</p>
      <dl class="portfolio-stats">
        ${stat(num(data.totals.translated), t('portfolio.strings'))}
        ${stat(num(data.totals.projects), t('portfolio.projects'))}
        ${stat(num(data.totals.complete), t('portfolio.complete'))}
        ${data.totals.contributions ? stat(num(data.totals.contributions), t('stats.changes')) : ''}
      </dl>
      <div class="row no-print">
        <button class="btn primary" type="button" data-portfolio="print">${t('portfolio.pdf')}</button>
        <button class="btn" type="button" data-portfolio="json">${t('portfolio.json')}</button>
        <button class="btn" type="button" data-portfolio="link">${t('team.share')}</button>
      </div>
      <p class="muted small no-print">${t('portfolio.pdfHint')}</p>
    </header>

    <section aria-labelledby="pf-projects" class="page">
      <h2 id="pf-projects">${t('portfolio.work')}</h2>
      ${
        data.projects.length
          ? `<ul class="portfolio-projects">${data.projects
              .map(
                (p) => `<li class="card">
          <span class="logo" aria-hidden="true">${p.logo ? `<img src="${esc(p.logo)}" alt="" width="44" height="44" loading="lazy" referrerpolicy="no-referrer" />` : ''}<span>${esc(initials(p.name))}</span></span>
          <div class="pf-body">
            <h3><a href="${esc(p.web || p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a></h3>
            <p class="muted small">${esc(p.language)} · ${esc(p.platform)}${p.since ? ` · ${t('portfolio.period', { from: shortDate(p.since, { month: 'short', year: 'numeric' }), to: shortDate(p.until, { month: 'short', year: 'numeric' }) })}` : ''}</p>
            <div class="mini-meter"><div class="bar" role="img" aria-label="${p.percent}%"><span style="width:${Math.min(100, p.percent)}%"></span></div><span>${p.percent}%</span></div>
            <p class="small">${t('portfolio.translated', { translated: p.translated, total: p.total })}${p.contributions ? ` · ${t('stats.dayCount', { count: p.contributions })}` : ''}</p>
          </div>
        </li>`,
              )
              .join('')}</ul>`
          : `<p class="muted">${t('team.noProjects')}</p>`
      }
    </section>

    ${
      chart
        ? `<section class="card block" aria-labelledby="pf-history">
      <h2 id="pf-history">${t('stats.chart.title')}</h2>
      <div class="chart">${chart.svg}</div>
    </section>`
        : ''
    }

    ${
      data.earned.length
        ? `<section class="card block" aria-labelledby="pf-ach">
      <h2 id="pf-ach">${t('achievements.title')}</h2>
      <ul class="medals">${data.earned
        .map(
          (a) =>
            `<li class="medal earned"><span class="medal-mark" aria-hidden="true">${esc(a.mark)}</span><span class="medal-text"><strong>${esc(achievementText(a))}</strong></span></li>`,
        )
        .join('')}</ul>
    </section>`
        : ''
    }
    <p class="muted small portfolio-foot">${t('portfolio.generated', { date: shortDate(new Date().toISOString(), { dateStyle: 'long' }), site: siteUrl() })}</p>`;
}

export function bind(root) {
  // An owner without an avatar (or no network): fall back to the initials.
  root.addEventListener(
    'error',
    (ev) => {
      if (ev.target.matches?.('.logo img')) ev.target.remove();
    },
    true,
  );
  root.addEventListener('click', (ev) => {
    const action = ev.target.closest('[data-portfolio]')?.dataset.portfolio;
    if (action === 'print') window.print();
    else if (action === 'link') copyText(location.href, tt('team.shared'));
    else if (action === 'json') {
      download(
        'resume-translation.json',
        `${JSON.stringify(toJsonResume(data, { site: location.href }), null, 2)}\n`,
        'application/json',
      );
    }
  });
}
