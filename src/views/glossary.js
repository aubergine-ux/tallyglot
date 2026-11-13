// Glossary: terms translated inconsistently across projects, and export.

import { buildTerms, exportPairs, toCsv, toTbx } from '../glossary.js';
import { t, tt } from '../i18n.js';
import { load, save } from '../store.js';
import { $, download, esc, num, toast } from '../ui.js';
import { notConfigured, pageHead, projectNames, tile } from './common.js';

const PAGE = 40;
const view = { query: '', show: 'inconsistent', shown: PAGE };
let glossary = null;
let preferred = {};

const terms = () => buildTerms(glossary, preferred);

/** Address of one string in Weblate's editor. */
function unitUrl(ctx, unit) {
  const [instanceId, id] = unit.key.split(':');
  const inst = ctx.config.instances.find((i) => i.id === instanceId);
  if (!inst) return '';
  const language = inst.language || ctx.config.language;
  return `${inst.url}/translate/${unit.path}/${encodeURIComponent(language)}/?q=id:${id}`;
}

function list(ctx) {
  const q = view.query.trim().toLowerCase();
  const names = projectNames(ctx.entries());
  const all = terms().filter(
    (term) =>
      (view.show === 'all' || !term.consistent) &&
      (!q ||
        term.term.toLowerCase().includes(q) ||
        term.variants.some((v) => v.target.toLowerCase().includes(q))),
  );
  if (!all.length) {
    return `<p class="none">${view.show === 'all' || q ? t('glossary.noMatch') : t('glossary.allConsistent')}</p>`;
  }
  const projectLabel = (key) => names[key] || key.split(':')[1];
  const items = all.slice(0, view.shown).map((term, index) => {
    const group = `term-${index}`;
    const variants = term.variants
      .map((v) => {
        // One link per project: the first string there that uses this translation.
        const seen = new Set();
        const firsts = v.units.filter((u) => {
          const project = `${u.key.split(':')[0]}:${u.path.split('/')[0]}`;
          return !seen.has(project) && seen.add(project);
        });
        const links = firsts
          .slice(0, 4)
          .map((u) => {
            const url = unitUrl(ctx, u);
            const label = projectLabel(`${u.key.split(':')[0]}:${u.path.split('/')[0]}`);
            return url
              ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}<span class="sr"> – ${esc(v.target)}</span></a>`
              : esc(label);
          })
          .join(', ');
        const chosen = term.preferred === v.target;
        return `
        <li class="variant${chosen ? ' chosen' : ''}">
          <div class="variant-main">
            <span class="variant-target" lang="${esc(ctx.config.language.replace(/_/g, '-'))}">${esc(v.target)}</span>
            <span class="muted small">${t('glossary.used', { count: v.count })} · ${t('count.projects', { count: v.projects.length })}</span>
          </div>
          <p class="muted small variant-links">${links}${firsts.length > 4 ? ` ${t('glossary.more', { count: firsts.length - 4 })}` : ''}</p>
          ${
            term.consistent
              ? ''
              : `<label class="check small"><input type="radio" name="${group}" data-term="${esc(term.key)}" value="${esc(v.target)}"${chosen ? ' checked' : ''} /><span>${t('glossary.prefer')}</span></label>`
          }
        </li>`;
      })
      .join('');
    return `
      <li class="card term">
        <div class="term-head">
          <h3>${esc(term.term)}</h3>
          ${
            term.consistent
              ? `<span class="tag ok">✓ ${t('glossary.consistent')}</span>`
              : term.preferred
                ? `<span class="tag ok">✓ ${t('glossary.decided')}</span>`
                : `<span class="tag stale">${t('glossary.variants', { count: term.variants.length })}</span>`
          }
        </div>
        <ul class="variants" role="${term.consistent ? 'list' : 'radiogroup'}" aria-label="${t('glossary.translationsOf', { term: term.term })}">${variants}</ul>
        ${term.preferred ? `<button class="link small" type="button" data-clear="${esc(term.key)}">${t('glossary.clear')}</button>` : ''}
      </li>`;
  });
  return `
    <p class="muted small" role="status">${t('glossary.count', { count: all.length })}</p>
    <ul class="terms">${items.join('')}</ul>
    ${all.length > view.shown ? `<div class="row"><button class="btn" type="button" data-more>${t('find.more')}</button></div>` : ''}`;
}

function summary() {
  const all = terms();
  const open = all.filter((x) => !x.consistent && !x.preferred).length;
  return `
    ${tile(num(all.length), t('glossary.terms'))}
    ${tile(num(all.filter((x) => !x.consistent).length), t('glossary.inconsistent'))}
    ${tile(num(open), t('glossary.undecided'))}
    ${tile(num(Object.keys(glossary.units).length), t('glossary.strings'))}`;
}

export async function render(ctx) {
  if (!ctx.configured()) return pageHead(t('nav.glossary')) + notConfigured(ctx);
  glossary = (await ctx.file('glossary')) || { units: {} };
  preferred = ctx.demo ? preferred : load('glossary-preferred', {});
  const has = Object.keys(glossary.units).length > 0;
  const chip = (value) =>
    `<button type="button" class="chip" data-show="${value}" aria-pressed="${view.show === value}">${t(`glossary.show.${value}`)}</button>`;
  return `
    ${pageHead(t('glossary.title'), t('glossary.intro'))}
    ${
      has
        ? `<section class="tiles stats-tiles" id="glossary-summary">${summary()}</section>
    <section class="toolbar" aria-label="${t('toolbar.label')}">
      <div class="toolbar-row">
        <label class="field search"><span class="sr">${t('glossary.search')}</span>
          <input id="glossary-query" type="search" placeholder="${t('glossary.searchHint')}" value="${esc(view.query)}" autocomplete="off" /></label>
      </div>
      <div class="chips" role="group" aria-label="${t('toolbar.filters')}">${chip('inconsistent')}${chip('all')}</div>
    </section>
    <section id="glossary-list">${list(ctx)}</section>
    <section class="card block" aria-labelledby="glossary-export">
      <h2 id="glossary-export">${t('glossary.export')}</h2>
      <p class="muted">${t('glossary.exportText')}</p>
      <label class="check"><input type="checkbox" id="glossary-strict" /><span>${t('glossary.strict')}</span></label>
      <div class="row">
        <button class="btn" type="button" data-export="csv">${t('glossary.csv')}</button>
        <button class="btn" type="button" data-export="tbx">${t('glossary.tbx')}</button>
      </div>
    </section>`
        : `<section class="welcome card"><h2>${t('glossary.empty')}</h2><p>${t('glossary.emptyText')}</p></section>`
    }`;
}

export function bind(root, ctx) {
  const redraw = () => {
    const el = $('#glossary-list', root);
    if (!el) return;
    el.innerHTML = list(ctx);
    $('#glossary-summary', root).innerHTML = summary();
  };
  const choose = (key, target) => {
    if (target === null) delete preferred[key];
    else preferred[key] = target;
    if (!ctx.demo) save('glossary-preferred', preferred);
  };
  root.addEventListener('input', (ev) => {
    if (ev.target.id !== 'glossary-query') return;
    view.query = ev.target.value;
    view.shown = PAGE;
    $('#glossary-list', root).innerHTML = list(ctx);
  });
  root.addEventListener('change', (ev) => {
    const key = ev.target.dataset.term;
    if (!key) return;
    choose(key, ev.target.value);
    redraw();
    // Redrawing replaced the radio button: put the focus back on it.
    root.querySelector(`input[data-term="${CSS.escape(key)}"]:checked`)?.focus();
  });
  root.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-show],[data-more],[data-clear],[data-export]');
    if (!el) return;
    if (el.dataset.show) {
      view.show = el.dataset.show;
      view.shown = PAGE;
      for (const chip of root.querySelectorAll('[data-show]')) {
        chip.setAttribute('aria-pressed', String(chip === el));
      }
      redraw();
    } else if ('more' in el.dataset) {
      view.shown += PAGE;
      redraw();
    } else if (el.dataset.clear) {
      choose(el.dataset.clear, null);
      redraw();
    } else if (el.dataset.export) {
      const pairs = exportPairs(terms(), { strict: $('#glossary-strict', root).checked });
      if (!pairs.length) {
        toast(tt('glossary.nothingToExport'));
        return;
      }
      const language = ctx.config.language;
      if (el.dataset.export === 'csv') {
        download(`glossary-${language}.csv`, toCsv(pairs), 'text/csv;charset=utf-8');
      } else {
        download(
          `glossary-${language}.tbx`,
          toTbx(pairs, {
            language,
            title: tt('glossary.fileTitle', { language: ctx.languageName() }),
          }),
          'application/x-tbx+xml',
        );
      }
      toast(tt('glossary.exported', { count: pairs.length }));
    }
  });
}
