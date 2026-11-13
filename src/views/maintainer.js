// Maintainer view: a project's coverage across all languages. Works for any
// project by address (?view=maintainer&platform=…&instance=…&project=…), so
// the link can be shared with people who have never set Tallyglot up.

import { NetworkError, NotFoundError, RateLimitError, normalizeBaseUrl } from '../api.js';
import { normalizeConfig } from '../core.js';
import { t, tt } from '../i18n.js';
import {
  coverageBadge,
  coverageChart,
  loadProject,
  maintainerKey,
  maintainerSnippet,
  summarizeLanguages,
} from '../maintainer.js';
import { getPlatform } from '../platforms/index.js';
import { PLATFORM_META, PRESETS } from '../presets.js';
import { $, ago, esc, num, siteUrl, svgUri } from '../ui.js';
import { pageHead, tile } from './common.js';

let token = ''; // typed on this page; kept in memory only

/** The instance a link refers to: a configured one by id, or any address. */
function resolveInstance(ctx, platform, ref) {
  const configured = ctx.config.instances.find(
    (i) => i.platform === platform && (i.id === ref || i.url === normalizeBaseUrl(ref) || !ref),
  );
  if (configured) return { instance: configured, configured: true };
  const preset = platform === 'weblate' && PRESETS.find((p) => p.id === ref);
  const raw = platform === 'weblate' ? (preset ? { id: preset.id } : { url: ref }) : { platform };
  const [instance] = normalizeConfig({ instances: [raw] }).instances;
  return { instance: instance || null, configured: false };
}

function form(q) {
  const platform = PLATFORM_META[q.platform] ? q.platform : 'weblate';
  const adapter = getPlatform(platform);
  return `
    <form id="maintainer-form" class="card block">
      <div class="toolbar-row">
        <label class="field"><span>${t('find.col.platform')}</span>
          <select name="platform">${Object.entries(PLATFORM_META)
            .map(
              ([id, meta]) =>
                `<option value="${id}"${id === platform ? ' selected' : ''}>${esc(meta.name)}</option>`,
            )
            .join('')}</select></label>
        <label class="field grow" data-only="weblate"${platform === 'weblate' ? '' : ' hidden'}><span>${t('maintainer.instance')}</span>
          <input name="instance" value="${esc(q.instance || (platform === 'weblate' ? 'hosted' : ''))}" list="maintainer-instances" placeholder="hosted" autocomplete="off" autocapitalize="off" spellcheck="false" />
          <datalist id="maintainer-instances">${PRESETS.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</datalist></label>
        <label class="field grow"><span>${t('maintainer.project')}</span>
          <input name="project" value="${esc(q.project || '')}" placeholder="${esc(tt(`maintainer.projectHint.${platform}`))}" required autocomplete="off" autocapitalize="off" spellcheck="false" /></label>
        <label class="field grow" data-token${adapter.tokenRequired ? '' : ' hidden'}><span>${t('maintainer.token')}</span>
          <input name="token" type="password" value="${esc(token)}" autocomplete="off" /></label>
        <button class="btn primary" type="submit">${t('maintainer.show')}</button>
      </div>
      <p class="muted small">${t('maintainer.formHint')}</p>
    </form>`;
}

function explain(err, instance) {
  if (err instanceof NotFoundError) return t('maintainer.error.notFound');
  if (err instanceof RateLimitError) return t('maintainer.error.limit', { name: instance.name });
  if (err instanceof NetworkError) return t('maintainer.error.network', { name: instance.name });
  return esc(err.message);
}

function report(ctx, view, { instance, key, generatedAt, published }) {
  const s = summarizeLanguages(view.languages, { staleDays: 90 });
  const share = new URL(
    ctx.pageUrl('maintainer', {
      platform: instance.platform,
      instance: PRESETS.some((p) => p.id === instance.id) || published ? instance.id : instance.url,
      project: ctx.query.get('project'),
    }),
    location.href,
  ).href;
  const site = siteUrl();
  const snippet = maintainerSnippet(site, key, share, view.project.name);
  const badge = `[![Translation status](${site}maintainer/${key}-badge.svg)](${share})`;
  const configLine = JSON.stringify(
    { maintainer: [{ instance: instance.id, project: ctx.query.get('project') }] },
    null,
    2,
  );
  return `
    <section class="card block">
      <div class="block-head">
        <h2><a href="${esc(view.project.url)}" target="_blank" rel="noopener">${esc(view.project.name)}</a>
          <span class="tag platform" data-platform="${esc(instance.platform)}">${esc(instance.name)}</span></h2>
        <button class="btn small" type="button" data-copy="${esc(share)}">${t('team.share')}</button>
      </div>
      ${generatedAt ? `<p class="muted small">${t('maintainer.snapshot', { when: ago(generatedAt) })}</p>` : ''}
      <div class="tiles stats-tiles">
        ${tile(num(s.count), t('maintainer.languages'))}
        ${tile(`${s.average}%`, t('maintainer.average'))}
        ${tile(num(s.complete), t('maintainer.complete'))}
        ${tile(s.datesKnown ? num(s.stale) : '–', t('maintainer.stale'), s.datesKnown ? t('maintainer.staleHint') : t('maintainer.staleUnknown'))}
      </div>
    </section>

    <section class="card block" aria-labelledby="m-langs">
      <h2 id="m-langs">${t('maintainer.coverage')}</h2>
      ${
        s.count
          ? `<div class="table-wrap tall"><table>
        <thead><tr><th>${t('maintainer.col.language')}</th><th>${t('find.col.coverage')}</th><th class="num">${t('find.col.left')}</th><th>${t('team.col.activity')}</th></tr></thead>
        <tbody>${s.rows
          .map(
            (l) => `<tr>
            <th scope="row"><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name)}</a> <span class="muted small">${esc(l.code)}</span></th>
            <td><div class="mini-meter"><div class="bar" role="img" aria-label="${l.percent}%"><span style="width:${Math.min(100, l.percent)}%"></span></div><span>${l.percent}%</span></div></td>
            <td class="num">${num(Math.max(0, l.total - l.translated))}</td>
            <td>${l.lastChange ? esc(ago(l.lastChange)) : '<span class="muted">–</span>'} ${l.stale ? `<span class="tag stale">◷ ${t('card.stale')}</span>` : ''}</td>
          </tr>`,
          )
          .join('')}</tbody>
      </table></div>`
          : `<p class="muted">${t('maintainer.noLanguages')}</p>`
      }
    </section>

    <section class="card block" aria-labelledby="m-people">
      <h2 id="m-people">${t('maintainer.translators')}</h2>
      ${
        view.translators === null
          ? `<p class="muted">${t('maintainer.translatorsUnknown', { platform: PLATFORM_META[instance.platform].name })}</p>`
          : view.translators.length
            ? `<div class="table-wrap"><table>
          <thead><tr><th>${t('team.col.member')}</th><th class="num">${t('team.col.changes')}</th><th>${t('maintainer.col.languages')}</th><th>${t('team.col.last')}</th></tr></thead>
          <tbody>${view.translators
            .slice(0, 25)
            .map(
              (p) =>
                `<tr><th scope="row">${esc(p.name)}</th><td class="num">${num(p.changes)}</td><td class="wrap">${esc(p.languages.join(', '))}</td><td>${esc(ago(p.last))}</td></tr>`,
            )
            .join('')}</tbody>
        </table></div><p class="muted small">${t('maintainer.translatorsNote')}</p>`
            : `<p class="muted">${t('maintainer.translatorsNone')}</p>`
      }
    </section>

    <section class="card block" aria-labelledby="m-readme">
      <h2 id="m-readme">${t('maintainer.readme')}</h2>
      <div class="card-pair">
        <figure><img src="${svgUri(coverageChart(view, 'light'))}" alt="${t('maintainer.chartAlt', { name: view.project.name })}" /></figure>
        <figure><img src="${svgUri(coverageBadge(view))}" alt="${t('maintainer.badgeAlt')}" height="20" /></figure>
      </div>
      ${
        published
          ? `<p class="muted">${t('maintainer.readmeLive')}</p>
        <label class="field"><span>${t('maintainer.chartSnippet')}</span>
          <textarea class="code-box" readonly rows="6">${esc(snippet)}</textarea></label>
        <div class="row"><button class="btn" type="button" data-copy="${esc(snippet)}">${t('card.copy')}</button>
          <button class="btn" type="button" data-copy="${esc(badge)}">${t('maintainer.copyBadge')}</button></div>`
          : `<p class="muted">${t('maintainer.readmeSetup')}</p>
        <label class="field"><span>tallyglot.config.json</span>
          <textarea class="code-box" readonly rows="8">${esc(configLine)}</textarea></label>
        <div class="row"><button class="btn" type="button" data-copy="${esc(configLine)}">${t('badges.copy')}</button>
          <a class="btn" href="${ctx.pageUrl('setup')}" data-nav="setup">${t('nav.setup')}</a></div>`
      }
    </section>`;
}

export async function render(ctx) {
  const q = Object.fromEntries(ctx.query);
  const head = pageHead(t('maintainer.title'), t('maintainer.intro'));
  if (!q.project) return head + form(q);

  const platform = PLATFORM_META[q.platform] ? q.platform : 'weblate';
  const { instance, configured } = resolveInstance(ctx, platform, q.instance || '');
  if (!instance)
    return `${head}${form(q)}<p class="notice warn">${t('maintainer.error.instance')}</p>`;
  const adapter = getPlatform(platform);
  const key = maintainerKey(instance.id, q.project);
  // What the Action wrote, if this project is listed under "maintainer".
  const saved = configured && !ctx.demo ? await ctx.file(`maintainer/${key}`) : null;
  const published =
    !!saved ||
    ctx.config.maintainer.some((m) => m.instance === instance.id && m.project === q.project);

  let view = null;
  let problem = '';
  const useToken = token || (configured ? ctx.tokens()[instance.id] : '');
  if (ctx.demo) {
    problem = t('maintainer.error.demo');
  } else if (adapter.browser === false && !saved) {
    problem = t('maintainer.error.actionOnly', { name: instance.name });
  } else if (adapter.tokenRequired && !useToken && !saved) {
    problem = t('maintainer.error.token', { name: instance.name });
  } else if (adapter.browser !== false && (!adapter.tokenRequired || useToken)) {
    try {
      view = await loadProject(
        adapter,
        adapter.createClient({ baseUrl: instance.url, token: useToken }),
        q.project,
      );
    } catch (err) {
      problem = explain(err, instance);
    }
  }
  if (view) return head + form(q) + report(ctx, view, { instance, key, published });
  if (saved) {
    return (
      head +
      form(q) +
      report(ctx, saved, { instance, key, generatedAt: saved.generatedAt, published })
    );
  }
  return `${head}${form(q)}<p class="notice warn" role="alert">${problem}</p>`;
}

export function bind(root, ctx) {
  const formEl = $('#maintainer-form', root);
  formEl.addEventListener('change', (ev) => {
    if (ev.target.name !== 'platform') return;
    const adapter = getPlatform(ev.target.value);
    $('[data-only="weblate"]', formEl).hidden = ev.target.value !== 'weblate';
    $('[data-token]', formEl).hidden = !adapter.tokenRequired;
    formEl.elements.project.placeholder = tt(`maintainer.projectHint.${ev.target.value}`);
  });
  formEl.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const data = new FormData(formEl);
    const platform = data.get('platform');
    token = String(data.get('token') || '').trim();
    ctx.navigate('maintainer', {
      platform,
      instance: platform === 'weblate' ? String(data.get('instance')).trim() : '',
      project: String(data.get('project')).trim(),
    });
  });
}
