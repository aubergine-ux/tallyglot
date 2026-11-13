// Community mode: the whole language team on one shareable page.

import { formatPercent } from '../badge.js';
import { aggregate, groupByProject, isComplete, nextStringUrl } from '../core.js';
import { t, tt } from '../i18n.js';
import { dayKey, leaderboard } from '../stats.js';
import { $, ago, copyText, esc, num, shortDate } from '../ui.js';
import { notConfigured, pageHead, projectNames, tile } from './common.js';

const view = { period: '30' };

function board(activity) {
  const since =
    view.period === 'all' ? undefined : dayKey(Date.now() - Number(view.period) * 86400000);
  const rows = leaderboard(activity, { since });
  if (!rows.length) return `<p class="muted">${t('team.boardEmpty')}</p>`;
  const top = rows[0].changes;
  return `
    <div class="table-wrap"><table>
      <thead><tr><th class="num">#</th><th>${t('team.col.member')}</th><th>${t('team.col.changes')}</th>
        <th class="num">${t('team.col.days')}</th><th>${t('team.col.last')}</th></tr></thead>
      <tbody>${rows
        .map(
          (r, i) => `<tr>
          <td class="num">${i + 1}</td>
          <th scope="row">${esc(r.name)}</th>
          <td><div class="mini-meter"><div class="bar" aria-hidden="true"><span style="width:${(r.changes / top) * 100}%"></span></div><span>${num(r.changes)}</span></div></td>
          <td class="num">${num(r.days)}</td>
          <td>${esc(shortDate(r.last))}</td>
        </tr>`,
        )
        .join('')}</tbody>
    </table></div>`;
}

export async function render(ctx) {
  if (!ctx.configured()) return pageHead(t('nav.team')) + notConfigured(ctx);
  const activity = await ctx.file('activity');
  const entries = ctx.entries();
  const language = ctx.languageName();
  const name = ctx.config.team.name || tt('team.defaultName', { language });
  const s = aggregate(entries, { staleDays: ctx.config.staleDays });
  const groups = groupByProject(entries);
  const names = projectNames(entries);
  const monthAgo = dayKey(Date.now() - 30 * 86400000);
  const active = leaderboard(activity, { since: monthAgo }).length;
  const members = new Set(ctx.config.instances.flatMap((i) => i.usernames)).size;

  const closest = groups
    .filter((g) => !g.entries.every(isComplete))
    .sort(
      (a, b) =>
        b.stats.percent - a.stats.percent ||
        a.stats.untranslated + a.stats.fuzzy - (b.stats.untranslated + b.stats.fuzzy),
    )
    .slice(0, 6);
  const next = (g) =>
    nextStringUrl(
      [...g.entries].sort((a, b) => b.untranslated + b.fuzzy - (a.untranslated + a.fuzzy))[0],
    );
  const recent = (activity?.recent || []).slice(0, 15);
  const option = (value, label) =>
    `<option value="${value}"${view.period === value ? ' selected' : ''}>${label}</option>`;

  return `
    ${pageHead(esc(name), t('team.intro', { language }))}
    <div class="row">
      <button class="btn" type="button" data-share>${t('team.share')}</button>
    </div>
    <section class="tiles stats-tiles">
      ${tile(entries.length ? formatPercent(s.percent) : '–', t('team.overall'))}
      ${tile(`${num(groups.filter((g) => g.entries.every(isComplete)).length)}<small>/${num(groups.length)}</small>`, t('team.projectsDone'))}
      ${tile(num(s.untranslated + s.fuzzy), t('hero.left'))}
      ${tile(`${num(active)}<small>/${num(members)}</small>`, t('team.active'), t('team.activeHint'))}
    </section>

    <section class="card block" aria-labelledby="team-closest">
      <h2 id="team-closest">${t('team.closest')}</h2>
      ${
        closest.length
          ? `<ul class="closest">${closest
              .map(
                (g) => `<li>
            <div class="closest-head"><strong>${esc(g.project.name)}</strong>
              <span class="tag platform" data-platform="${esc(g.entries[0].platform || 'weblate')}">${esc(ctx.instanceName(g.instance))}</span></div>
            <div class="mini-meter"><div class="bar" role="img" aria-label="${formatPercent(g.stats.percent)}"><span style="width:${g.stats.percent}%"></span></div>
              <span>${formatPercent(g.stats.percent)}</span></div>
            <div class="closest-foot"><span class="muted">${t('team.left', { count: g.stats.untranslated + g.stats.fuzzy })}</span>
              <a class="btn small" href="${esc(next(g))}" target="_blank" rel="noopener">${t('find.start')}<span class="sr">: ${esc(g.project.name)}</span></a></div>
          </li>`,
              )
              .join('')}</ul>`
          : `<p class="muted">${entries.length ? t('team.allDone') : t('team.noProjects')}</p>`
      }
    </section>

    <section class="card block" aria-labelledby="team-board">
      <div class="block-head">
        <h2 id="team-board">${t('team.board')}</h2>
        <label class="field inline"><span class="sr">${t('stats.chart.range')}</span>
          <select id="team-period">
            ${option('7', t('team.period7'))}${option('30', t('team.period30'))}${option('365', t('team.period365'))}${option('all', t('team.periodAll'))}
          </select></label>
      </div>
      <div id="team-board-body">${board(activity)}</div>
    </section>

    <section class="card block" aria-labelledby="team-recent">
      <h2 id="team-recent">${t('team.recent')}</h2>
      ${
        recent.length
          ? `<ol class="timeline wide">${recent
              .map(
                (r) =>
                  `<li><time datetime="${esc(r.at)}">${esc(ago(r.at))}</time><span><strong>${esc(r.user)}</strong> · ${esc(names[r.project] || r.project.split(':')[1])} <span class="muted">${esc(r.component)}${r.action ? ` · ${esc(r.action)}` : ''}</span></span></li>`,
              )
              .join('')}</ol>`
          : `<p class="muted">${t('team.recentEmpty')}</p>`
      }
    </section>

    <section class="card block" aria-labelledby="team-all">
      <h2 id="team-all">${t('team.all', { count: groups.length })}</h2>
      ${
        groups.length
          ? `<div class="table-wrap tall"><table>
        <thead><tr><th>${t('find.col.project')}</th><th>${t('find.col.platform')}</th><th>${t('find.col.coverage')}</th>
          <th class="num">${t('find.col.left')}</th><th class="num">${t('team.col.components')}</th><th>${t('team.col.activity')}</th></tr></thead>
        <tbody>${groups
          .sort((a, b) => a.project.name.localeCompare(b.project.name))
          .map(
            (g) => `<tr>
            <th scope="row" class="wrap"><a href="${esc(g.project.url)}" target="_blank" rel="noopener">${esc(g.project.name)}</a></th>
            <td><span class="tag platform" data-platform="${esc(g.entries[0].platform || 'weblate')}">${esc(ctx.instanceName(g.instance))}</span></td>
            <td><div class="mini-meter"><div class="bar" role="img" aria-label="${formatPercent(g.stats.percent)}"><span style="width:${g.stats.percent}%"></span></div><span>${formatPercent(g.stats.percent)}</span></div></td>
            <td class="num">${num(g.stats.untranslated + g.stats.fuzzy)}</td>
            <td class="num">${num(g.stats.components)}</td>
            <td>${g.stats.lastChange ? esc(ago(g.stats.lastChange)) : '<span class="muted">–</span>'}</td>
          </tr>`,
          )
          .join('')}</tbody>
      </table></div>`
          : `<p class="muted">${t('team.noProjects')}</p>`
      }
    </section>`;
}

export function bind(root, ctx) {
  root.addEventListener('change', async (ev) => {
    if (ev.target.id !== 'team-period') return;
    view.period = ev.target.value;
    $('#team-board-body', root).innerHTML = board(await ctx.file('activity'));
  });
  root.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-share]')) copyText(location.href, tt('team.shared'));
  });
}
