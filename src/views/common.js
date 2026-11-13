// Pieces every page uses.

import { t } from '../i18n.js';

export const pageHead = (title, intro = '') =>
  `<header class="page-head"><h1>${title}</h1>${intro ? `<p class="muted">${intro}</p>` : ''}</header>`;

export const emptyState = (title, text, action = '') =>
  `<section class="welcome card"><h2>${title}</h2><p>${text}</p>${action ? `<div class="row">${action}</div>` : ''}</section>`;

/** Shown in place of a page that needs a language and a platform to be set. */
export const notConfigured = (ctx) =>
  emptyState(
    t('shell.notConfigured'),
    t('shell.notConfiguredText'),
    `<a class="btn primary" href="${ctx.pageUrl('setup')}" data-nav="setup">${t('welcome.guided')}</a>
     <button class="btn" data-action="settings" type="button">${t('shell.settings')}</button>`,
  );

/** Shown when the Action has not written a page's data file yet. */
export const noData = () => emptyState(t('shell.noData'), t('shell.noDataText'));

export const tile = (value, label, hint = '') =>
  `<div class="tile"${hint ? ` title="${hint}"` : ''}><span class="tile-value">${value}</span><span class="tile-label">${label}</span></div>`;

/** "hosted:trale" -> the project's display name, from the entries on screen. */
export function projectNames(entries) {
  const names = {};
  for (const e of entries) names[`${e.instance}:${e.project.slug}`] = e.project.name;
  return names;
}
