// Guided setup: builds tallyglot.config.json from a form and walks through
// forking, without a terminal or a text editor.

import { normalizeBaseUrl } from '../api.js';
import { normalizeConfig } from '../core.js';
import { t, tt } from '../i18n.js';
import { getPlatform } from '../platforms/index.js';
import { PLATFORM_META, PRESETS, UPSTREAM } from '../presets.js';
import { load, save } from '../store.js';
import { $, $$, copyText, download, esc, toast } from '../ui.js';
import { pageHead } from './common.js';

const OTHERS = Object.keys(PLATFORM_META).filter((id) => id !== 'weblate');
const split = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const blank = () => ({
  language: '',
  usernames: '',
  weblate: { hosted: true },
  custom: [], // extra Weblate addresses
  platforms: {}, // id -> { on, projects, language }
  team: '',
  displayName: '',
  rss: true,
  webhook: false,
  issue: false,
  digest: true,
  github: '',
  repo: UPSTREAM.split('/')[1],
  done: {},
});

let form = null;

/** The saved draft, else an empty form: a visitor sets up their own dashboard. */
const initial = () => ({ ...blank(), ...load('setup', {}) });

/** Fill the form from the configuration this dashboard runs with. */
function fromConfig(cfg) {
  const f = blank();
  f.language = cfg.language;
  f.usernames = cfg.usernames.join(', ');
  f.team = cfg.team.name;
  f.displayName = cfg.displayName;
  f.weblate = {};
  for (const inst of cfg.instances) {
    if (inst.platform !== 'weblate') {
      f.platforms[inst.platform] = {
        on: true,
        projects: inst.pinned.join(', '),
        language: inst.language,
      };
    } else if (PRESETS.some((p) => p.id === inst.id)) {
      f.weblate[inst.id] = inst.enabled;
    } else {
      f.custom.push(inst.url);
    }
  }
  f.rss = cfg.alerts.channels.includes('rss');
  f.webhook = cfg.alerts.channels.includes('webhook');
  f.issue = cfg.alerts.channels.includes('issue');
  f.digest = cfg.alerts.digest;
  return f;
}

/** The config the form describes: only what differs from the defaults is written. */
export function buildConfig(f) {
  const instances = [
    ...PRESETS.filter((p) => f.weblate[p.id]).map((p) => ({ id: p.id })),
    ...f.custom.map((url) => ({ url })),
    ...OTHERS.filter((id) => f.platforms[id]?.on).map((id) => ({
      platform: id,
      ...(split(f.platforms[id].projects).length
        ? { projects: split(f.platforms[id].projects) }
        : {}),
      ...(f.platforms[id].language?.trim() ? { language: f.platforms[id].language.trim() } : {}),
    })),
  ];
  const channels = ['rss', 'webhook', 'issue'].filter((c) => f[c]);
  const defaultAlerts = channels.join() === 'rss' && f.digest;
  return {
    language: f.language.trim(),
    usernames: split(f.usernames),
    instances,
    ...(f.displayName.trim() ? { displayName: f.displayName.trim() } : {}),
    ...(f.team.trim() ? { team: { name: f.team.trim() } } : {}),
    ...(defaultAlerts ? {} : { alerts: { channels, digest: f.digest } }),
  };
}

/** What still stops the config from working, as translated sentences. */
export function problems(f) {
  const out = [];
  const config = buildConfig(f);
  if (!config.language) out.push(tt('setup.problem.language'));
  else if (!/^[A-Za-z]{2,3}([_-][A-Za-z0-9@]+)*$/.test(config.language))
    out.push(tt('setup.problem.languageShape'));
  if (!config.instances.length) out.push(tt('setup.problem.platform'));
  const weblate = config.instances.some((i) => !i.platform);
  if (weblate && !config.usernames.length) out.push(tt('setup.problem.username'));
  for (const id of OTHERS) {
    const p = f.platforms[id];
    if (p?.on && id !== 'pontoon' && !split(p.projects).length) {
      out.push(tt('setup.problem.projects', { platform: PLATFORM_META[id].name }));
    }
    if (
      p?.on &&
      id === 'transifex' &&
      split(p.projects).some((x) => !/^[^/\s]+\/[^/\s]+$/.test(x))
    ) {
      out.push(tt('setup.problem.transifex'));
    }
  }
  return out;
}

const configText = (f) => `${JSON.stringify(buildConfig(f), null, 2)}\n`;

function output() {
  const issues = problems(form);
  return `
    ${
      issues.length
        ? `<ul class="notice warn problem-list">${issues.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
        : `<p class="notice info">${t('setup.ready')}</p>`
    }
    <label class="field"><span>tallyglot.config.json</span>
      <textarea class="code-box" id="setup-json" readonly rows="${Math.min(22, configText(form).split('\n').length)}">${esc(configText(form))}</textarea></label>
    <div class="row">
      <button class="btn primary" type="button" data-setup="copy">${t('setup.copy')}</button>
      <button class="btn" type="button" data-setup="download">${t('setup.download')}</button>
      <button class="btn" type="button" data-setup="try"${issues.length ? ' disabled' : ''}>${t('setup.try')}</button>
    </div>`;
}

function steps() {
  const user = form.github.trim().replace(/^@/, '');
  const repo = form.repo.trim() || UPSTREAM.split('/')[1];
  const mine = user
    ? `https://github.com/${encodeURIComponent(user)}/${encodeURIComponent(repo)}`
    : '';
  const needsTokens = OTHERS.some((id) => form.platforms[id]?.on && getPlatform(id).tokenRequired);
  const link = (href, label) =>
    href
      ? `<a class="btn small" href="${esc(href)}" target="_blank" rel="noopener">${label} <span aria-hidden="true">↗</span></a>`
      : `<span class="muted small">${t('setup.needUser')}</span>`;
  const list = [
    [
      'fork',
      t('setup.step.fork'),
      t('setup.step.forkText'),
      link(`https://github.com/${UPSTREAM}/fork`, t('setup.step.forkLink')),
    ],
    [
      'config',
      t('setup.step.config'),
      t('setup.step.configText'),
      link(mine && `${mine}/edit/main/tallyglot.config.json`, t('setup.step.configLink')),
    ],
    ...(needsTokens || form.webhook
      ? [
          [
            'secrets',
            t('setup.step.secrets'),
            `${needsTokens ? t('setup.step.secretsTokens') : ''} ${form.webhook ? t('setup.step.secretsWebhook') : ''}`,
            link(mine && `${mine}/settings/secrets/actions`, t('setup.step.secretsLink')),
          ],
        ]
      : []),
    [
      'pages',
      t('setup.step.pages'),
      t('setup.step.pagesText'),
      link(mine && `${mine}/settings/pages`, t('setup.step.pagesLink')),
    ],
    [
      'actions',
      t('setup.step.actions'),
      t('setup.step.actionsText'),
      link(mine && `${mine}/actions/workflows/badges.yml`, t('setup.step.actionsLink')),
    ],
    [
      'open',
      t('setup.step.open'),
      t('setup.step.openText'),
      link(
        user &&
          `https://${encodeURIComponent(user.toLowerCase())}.github.io/${encodeURIComponent(repo)}/`,
        t('setup.step.openLink'),
      ),
    ],
  ];
  return `<ol class="steps">${list
    .map(
      ([id, title, text, action]) => `
      <li class="${form.done[id] ? 'done' : ''}">
        <label class="check"><input type="checkbox" data-done="${id}"${form.done[id] ? ' checked' : ''} /><span><strong>${title}</strong></span></label>
        <p class="muted">${text}</p>
        <div class="row">${action}</div>
      </li>`,
    )
    .join('')}</ol>`;
}

const text = (name, label, value, placeholder = '', hint = '') => `
  <label class="field"><span>${label}</span>
    <input name="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" autocapitalize="off" spellcheck="false" />
    ${hint ? `<small class="muted">${hint}</small>` : ''}</label>`;
const check = (name, label, on, hint = '') => `
  <label class="check"><input type="checkbox" name="${name}"${on ? ' checked' : ''} /><span>${label}${hint ? ` <span class="muted">${hint}</span>` : ''}</span></label>`;

function customList() {
  return form.custom.length
    ? `<ul class="custom-list">${form.custom
        .map(
          (url, i) =>
            `<li><code>${esc(url)}</code> <button class="btn small" type="button" data-remove="${i}">${t('setup.remove')}<span class="sr">: ${esc(url)}</span></button></li>`,
        )
        .join('')}</ul>`
    : '';
}

export function render(ctx) {
  form ||= initial();
  return `
    ${pageHead(t('setup.title'), t('setup.intro'))}
    ${ctx.config.language && !ctx.demo ? `<div class="row"><button class="btn" type="button" data-setup="prefill">${t('setup.prefill')}</button></div>` : ''}
    <form id="setup-form" class="page" novalidate>
      <section class="card block">
        <h2><span class="step-no">1</span> ${t('setup.language')}</h2>
        <div class="pair">
          ${text('language', t('settings.language'), form.language, 'sq', t('setup.languageHint'))}
          ${text('displayName', t('setup.displayName'), form.displayName, '', t('setup.displayNameHint'))}
        </div>
      </section>

      <section class="card block">
        <h2><span class="step-no">2</span> ${t('setup.platforms')}</h2>
        <fieldset class="plain"><legend>Weblate</legend>
          ${text('usernames', t('settings.usernames'), form.usernames, 'alice', t('setup.usernamesHint'))}
          <div class="checks">${PRESETS.map((p) => check(`weblate:${p.id}`, esc(p.name), form.weblate[p.id], esc(p.url.replace('https://', '')))).join('')}</div>
          <div id="setup-custom">${customList()}</div>
          <div class="add-inst">
            <label class="field"><span>${t('settings.addWeblate')}</span>
              <input id="setup-url" type="url" placeholder="https://weblate.example.org" autocomplete="off" /></label>
            <button class="btn" type="button" data-setup="add-url">${t('settings.add')}</button>
          </div>
        </fieldset>
        ${OTHERS.map((id) => {
          const p = form.platforms[id] || {};
          const adapter = getPlatform(id);
          return `<fieldset class="plain"><legend>${esc(PLATFORM_META[id].name)}</legend>
            ${check(`on:${id}`, t('setup.use', { platform: PLATFORM_META[id].name }), p.on, adapter.tokenRequired ? t('setup.needsToken') : '')}
            <div class="pair" data-fields="${id}"${p.on ? '' : ' hidden'}>
              ${text(`projects:${id}`, t('settings.projects'), p.projects || '', tt(`settings.projectsHint.${id}`))}
              ${text(`language:${id}`, t('settings.languageHere'), p.language || '', adapter.languageCode(form.language || 'pt_BR'))}
            </div></fieldset>`;
        }).join('')}
      </section>

      <section class="card block">
        <h2><span class="step-no">3</span> ${t('setup.options')}</h2>
        ${text('team', t('setup.team'), form.team, '', t('setup.teamHint'))}
        <fieldset class="plain"><legend>${t('setup.alerts')}</legend>
          <p class="muted small">${t('setup.alertsText')}</p>
          <div class="checks">
            ${check('rss', t('setup.rss'), form.rss)}
            ${check('webhook', t('setup.webhook'), form.webhook)}
            ${check('issue', t('setup.issue'), form.issue)}
            ${check('digest', t('setup.digest'), form.digest)}
          </div>
        </fieldset>
      </section>

      <section class="card block" aria-labelledby="setup-out">
        <h2 id="setup-out"><span class="step-no">4</span> ${t('setup.result')}</h2>
        <div id="setup-output" aria-live="polite">${output()}</div>
      </section>

      <section class="card block" aria-labelledby="setup-walk">
        <h2 id="setup-walk"><span class="step-no">5</span> ${t('setup.publish')}</h2>
        <p class="muted">${t('setup.publishText')}</p>
        <div class="pair">
          ${text('github', t('setup.github'), form.github, 'alice')}
          ${text('repo', t('setup.repo'), form.repo, 'tallyglot')}
        </div>
        <div id="setup-steps">${steps()}</div>
        <div class="row"><button class="btn" type="button" data-setup="reset">${t('setup.reset')}</button></div>
      </section>
    </form>`;
}

export function bind(root, ctx) {
  const persist = () => {
    if (!ctx.demo) save('setup', form);
  };
  const refresh = () => {
    $('#setup-output', root).innerHTML = output();
    $('#setup-steps', root).innerHTML = steps();
    persist();
  };
  root.addEventListener('submit', (ev) => ev.preventDefault());
  root.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.dataset.done) {
      form.done[el.dataset.done] = el.checked;
      el.closest('li').classList.toggle('done', el.checked);
      persist();
      return;
    }
    if (!el.name) return;
    const [kind, id] = el.name.split(':');
    const value = el.type === 'checkbox' ? el.checked : el.value;
    if (kind === 'weblate') form.weblate[id] = value;
    else if (kind === 'on') {
      (form.platforms[id] ||= {}).on = value;
      $(`[data-fields="${id}"]`, root).hidden = !value;
    } else if (kind === 'projects' || kind === 'language') {
      if (id) (form.platforms[id] ||= {})[kind] = value;
      else form[kind] = value;
    } else form[kind] = value;
    refresh();
  });
  root.addEventListener('click', (ev) => {
    const remove = ev.target.closest('[data-remove]');
    if (remove) {
      form.custom.splice(Number(remove.dataset.remove), 1);
      $('#setup-custom', root).innerHTML = customList();
      refresh();
      $('#setup-url', root).focus();
      return;
    }
    const action = ev.target.closest('[data-setup]')?.dataset.setup;
    if (action === 'copy') copyText(configText(form), tt('toast.configCopied'));
    else if (action === 'download')
      download('tallyglot.config.json', configText(form), 'application/json');
    else if (action === 'add-url') {
      const input = $('#setup-url', root);
      const url = normalizeBaseUrl(input.value);
      let valid = false;
      try {
        valid = !!url && new URL(url).hostname.includes('.');
      } catch {}
      if (!valid) {
        toast(tt('toast.badAddress'));
        input.focus();
        return;
      }
      const known = PRESETS.find((p) => p.url === url);
      if (known) {
        form.weblate[known.id] = true;
        $(`[name="weblate:${known.id}"]`, root).checked = true;
      } else if (!form.custom.includes(url)) form.custom.push(url);
      input.value = '';
      $('#setup-custom', root).innerHTML = customList();
      refresh();
    } else if (action === 'try') {
      save('settings', buildConfig(form));
      ctx.state.overridden = true;
      ctx.state.config = normalizeConfig(buildConfig(form));
      location.href = ctx.pageUrl('dashboard');
    } else if (action === 'reset' || action === 'prefill') {
      save('setup', null);
      form = action === 'prefill' ? fromConfig(ctx.config) : null;
      ctx.navigate('setup', {}, { replace: true });
      $$('input', root)[0]?.focus();
    }
  });
}
