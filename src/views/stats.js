// Stats: contribution calendar, streaks, completion over time, milestones.

import {
  calendar,
  dailyCounts,
  historyDays,
  milestones,
  series,
  streaks,
  totalChanges,
} from '../stats.js';
import { heatmap, lineChart } from '../charts.js';
import { currentLocale, t, tt } from '../i18n.js';
import { $, esc, num, shortDate } from '../ui.js';
import { notConfigured, pageHead, projectNames, tile } from './common.js';

const view = { project: '', range: '365' };

async function loadHistory(ctx) {
  const index = await ctx.file('history/index');
  const years = await Promise.all((index?.years || []).map((y) => ctx.file(`history/${y}`)));
  return historyDays(years.filter(Boolean));
}

const monthNames = () =>
  Array.from({ length: 12 }, (_, i) =>
    new Date(Date.UTC(2024, i, 1)).toLocaleDateString(currentLocale().replace(/_/g, '-'), {
      month: 'short',
      timeZone: 'UTC',
    }),
  );

export function milestoneText(m) {
  if (m.kind === 'complete') return t('stats.milestone.complete', { name: m.name });
  if (m.kind === 'monthComplete') return t('stats.milestone.month', { count: m.count });
  if (m.kind === 'changes') return t('stats.milestone.changes', { count: m.count });
  return t('stats.milestone.streak', { count: m.count });
}

function chartSection(points, names) {
  const keys = [...new Set(points.flatMap((p) => Object.keys(p.p || {})))].sort((a, b) =>
    (names[a] || a).localeCompare(names[b] || b),
  );
  if (view.project && !keys.includes(view.project)) view.project = '';
  const cutoff =
    view.range === 'all' || !points.length
      ? ''
      : new Date(Date.parse(points[points.length - 1].day) - Number(view.range) * 86400000)
          .toISOString()
          .slice(0, 10);
  const data = series(points, view.project).filter((p) => p.day >= cutoff);
  const option = (value, label, current) =>
    `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
  const controls = `
    <div class="toolbar-row">
      <label class="field grow"><span>${t('stats.chart.project')}</span>
        <select id="chart-project">
          ${option('', tt('stats.chart.overall'), view.project)}
          ${keys.map((k) => option(k, names[k] || k, view.project)).join('')}
        </select></label>
      <label class="field"><span>${t('stats.chart.range')}</span>
        <select id="chart-range">
          ${['30', '90', '365', 'all'].map((r) => option(r, tt(`stats.chart.range${r}`), view.range)).join('')}
        </select></label>
    </div>`;
  if (!data.length) {
    return `${controls}<p class="muted">${t('stats.chart.empty')}</p>`;
  }
  const title = view.project ? names[view.project] || view.project : tt('stats.chart.overall');
  const chart = lineChart(data, {
    // Drawn at the size it is shown, so text keeps its size on any screen.
    width: Math.max(300, Math.min(1090, document.documentElement.clientWidth - 74)),
    height: document.documentElement.clientWidth < 600 ? 200 : 260,
    label: tt('stats.chart.label', {
      name: title,
      from: data[0].percent,
      to: data[data.length - 1].percent,
    }),
    formatDay: (d) => shortDate(d),
  });
  const rows = data
    .slice(-400)
    .reverse()
    .map(
      (p) =>
        `<tr><td>${esc(shortDate(p.day))}</td><td>${p.percent}%</td><td>${num(p.translated)}</td><td>${num(p.total)}</td></tr>`,
    )
    .join('');
  return `${controls}
    <div class="chart" id="chart" tabindex="0" role="group" aria-label="${t('stats.chart.keys')}"
      data-coords="${esc(JSON.stringify(chart.coords.map((c) => [c.x, c.y, c.day, c.percent, c.translated, c.total])))}"
      data-width="${chart.width}">
      ${chart.svg}
      <div class="chart-tip" hidden></div>
    </div>
    ${data.length < 2 ? `<p class="muted small">${t('stats.chart.single')}</p>` : ''}
    <details class="table-view"><summary>${t('stats.table')}</summary>
      <div class="table-wrap"><table>
        <thead><tr><th>${t('stats.col.day')}</th><th>${t('stats.col.percent')}</th><th>${t('stats.col.translated')}</th><th>${t('stats.col.total')}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </details>`;
}

export async function render(ctx) {
  if (!ctx.configured()) return pageHead(t('nav.stats')) + notConfigured(ctx);
  const [activity, points] = await Promise.all([ctx.file('activity'), loadHistory(ctx)]);
  const names = projectNames(ctx.entries());
  const counts = dailyCounts(activity);
  const s = streaks(counts);
  const cal = calendar(counts);
  const hasActivity = Object.keys(counts).length > 0;
  const months = monthNames();
  const byMonth = {};
  for (const column of cal.columns) {
    for (const c of column)
      if (c) byMonth[c.day.slice(0, 7)] = (byMonth[c.day.slice(0, 7)] || 0) + c.count;
  }
  const events = milestones(points, activity, { names }).slice(0, 12);

  return `
    ${pageHead(t('stats.title', { language: ctx.languageName() }), t('stats.intro'))}
    <section class="tiles stats-tiles">
      ${tile(num(totalChanges(counts)), t('stats.changes'), t('stats.changesHint'))}
      ${tile(t('count.days', { count: s.current }), t('stats.streak'))}
      ${tile(t('count.days', { count: s.longest }), t('stats.longest'), s.longestEnd ? `${shortDate(s.longestStart)} – ${shortDate(s.longestEnd)}` : '')}
      ${tile(num(s.activeDays), t('stats.activeDays'))}
    </section>

    <section class="card block" aria-labelledby="cal-title">
      <h2 id="cal-title">${t('stats.calendar')}</h2>
      ${
        hasActivity
          ? `<p class="muted">${t('stats.calendarSum', { count: cal.total })}</p>
        <div class="heatmap-scroll" tabindex="0" role="group" aria-label="${t('stats.calendar')}">
          ${heatmap(cal, {
            months,
            label: tt('stats.calendarSum', { count: cal.total }),
            describe: (c) => `${shortDate(c.day)}: ${tt('stats.dayCount', { count: c.count })}`,
          })}
        </div>
        <p class="legend"><span>${t('stats.less')}</span>${[0, 1, 2, 3, 4].map((l) => `<i class="heat-${l}"></i>`).join('')}<span>${t('stats.more')}</span></p>
        <details class="table-view"><summary>${t('stats.table')}</summary>
          <div class="table-wrap"><table>
            <thead><tr><th>${t('stats.col.month')}</th><th>${t('stats.col.changes')}</th></tr></thead>
            <tbody>${Object.keys(byMonth)
              .sort()
              .reverse()
              .map(
                (m) =>
                  `<tr><td>${esc(shortDate(`${m}-01`, { month: 'long', year: 'numeric' }))}</td><td>${num(byMonth[m])}</td></tr>`,
              )
              .join('')}</tbody>
          </table></div>
        </details>`
          : `<p class="muted">${t('stats.calendarEmpty')}</p>`
      }
    </section>

    <section class="card block" aria-labelledby="chart-title">
      <h2 id="chart-title">${t('stats.chart.title')}</h2>
      <div id="chart-box">${chartSection(points, names)}</div>
    </section>

    <section class="card block" aria-labelledby="ms-title">
      <h2 id="ms-title">${t('stats.milestones')}</h2>
      ${
        events.length
          ? `<ol class="timeline">${events
              .map(
                (m) =>
                  `<li><time datetime="${m.day}">${esc(shortDate(m.day))}</time><span>${milestoneText(m)}</span></li>`,
              )
              .join('')}</ol>`
          : `<p class="muted">${t('stats.milestonesEmpty')}</p>`
      }
    </section>
    <div id="stats-extra"></div>`;
}

/** Crosshair and tooltip that follow the pointer or the arrow keys. */
function bindChart(root) {
  const box = $('#chart', root);
  if (!box) return;
  const coords = JSON.parse(box.dataset.coords);
  const svg = $('svg', box);
  const hover = $('.chart-hover', box);
  const tip = $('.chart-tip', box);
  let index = coords.length - 1;
  const show = (i) => {
    index = Math.max(0, Math.min(coords.length - 1, i));
    const [x, y, day, percent, translated, total] = coords[index];
    hover.style.display = '';
    $('line', hover).setAttribute('x1', x);
    $('line', hover).setAttribute('x2', x);
    $('circle', hover).setAttribute('cx', x);
    $('circle', hover).setAttribute('cy', y);
    tip.hidden = false;
    tip.innerHTML = `<strong>${percent}%</strong> ${esc(shortDate(day))}<br>${t('stats.tip', { translated, total })}`;
    const scale = svg.getBoundingClientRect().width / Number(box.dataset.width);
    const left = Math.min(Math.max(x * scale, 70), box.clientWidth - 70);
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(0, y * scale - 12)}px`;
  };
  const hide = () => {
    hover.style.display = 'none';
    tip.hidden = true;
  };
  box.addEventListener('pointermove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * Number(box.dataset.width);
    let best = 0;
    coords.forEach((c, i) => {
      if (Math.abs(c[0] - x) < Math.abs(coords[best][0] - x)) best = i;
    });
    show(best);
  });
  box.addEventListener('pointerleave', hide);
  box.addEventListener('focus', () => show(index));
  box.addEventListener('blur', hide);
  box.addEventListener('keydown', (ev) => {
    const move = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity }[ev.key];
    if (!move) return;
    ev.preventDefault();
    show(Number.isFinite(move) ? index + move : move < 0 ? 0 : coords.length - 1);
  });
}

export function bind(root, ctx) {
  bindChart(root);
  // Show the most recent weeks when the calendar is wider than the screen.
  const scroller = $('.heatmap-scroll', root);
  if (scroller) scroller.scrollLeft = scroller.scrollWidth;
  root.addEventListener('change', async (ev) => {
    if (ev.target.id !== 'chart-project' && ev.target.id !== 'chart-range') return;
    view.project = $('#chart-project', root).value;
    view.range = $('#chart-range', root).value;
    const focus = ev.target.id;
    $('#chart-box', root).innerHTML = chartSection(
      await loadHistory(ctx),
      projectNames(ctx.entries()),
    );
    bindChart(root);
    $(`#${focus}`, root)?.focus();
  });
  const extra = $('#stats-extra', root);
  if (extra) {
    import('./profile.js').then((m) => m.mount(extra, ctx));
  }
}
