// The lower half of the Stats page: achievements and the profile card.

import { achievements } from '../achievements.js';
import { CARD_FAMILIES, cardData, cardFiles, cardSnippet, renderCard } from '../card.js';
import { t, tt } from '../i18n.js';
import { $, esc, siteUrl, svgUri } from '../ui.js';

let family = 'default';

export const cardTitle = (ctx) => {
  const { config } = ctx;
  const name = config.team.name || config.displayName || config.usernames[0] || '';
  return name ? `${name} · ${ctx.languageName()}` : `${ctx.languageName()} translations`;
};

export function achievementText(a) {
  if (a.kind === 'platform') return tt('achievements.platform', { platform: a.platform });
  return tt(`achievements.${a.kind}`, { count: a.goal });
}

export function medals(list) {
  return `<ul class="medals">${list
    .map(
      (a) => `
      <li class="medal${a.earned ? ' earned' : ''}">
        <span class="medal-mark" aria-hidden="true">${esc(a.mark)}</span>
        <span class="medal-text"><strong>${esc(achievementText(a))}</strong>
          <span class="muted">${a.earned ? t('achievements.earned') : t('achievements.progress', { value: a.value, goal: a.goal })}</span></span>
      </li>`,
    )
    .join('')}</ul>`;
}

function cardSection(ctx, activity) {
  const data = cardData({ entries: ctx.entries(), activity, title: cardTitle(ctx) });
  const files = cardFiles(family);
  const snippet = cardSnippet(siteUrl(), family, tt('card.alt', { language: ctx.languageName() }));
  const theme = (name) =>
    name === 'default' ? ['light', 'dark'] : [`${name}-light`, `${name}-dark`];
  return `
    <p class="muted">${t('card.text')}</p>
    <div class="chips" role="group" aria-label="${t('card.theme')}">
      ${CARD_FAMILIES.map(
        (f) =>
          `<button type="button" class="chip" data-family="${f}" aria-pressed="${f === family}">${t(`card.themes.${f}`)}</button>`,
      ).join('')}
    </div>
    <div class="card-pair">
      ${theme(family)
        .map(
          (name, i) =>
            `<figure><img src="${svgUri(renderCard(data, name))}" alt="${t(i ? 'card.darkAlt' : 'card.lightAlt')}" width="480" />
             <figcaption class="muted small">${t(i ? 'card.dark' : 'card.light')} · <code>cards/${i ? files.dark : files.light}</code></figcaption></figure>`,
        )
        .join('')}
    </div>
    <label class="field"><span>${t('card.snippet')}</span>
      <textarea class="code-box" readonly rows="6" id="card-snippet">${esc(snippet)}</textarea></label>
    <div class="row"><button class="btn" type="button" data-copy="${esc(snippet)}">${t('card.copy')}</button></div>`;
}

export async function mount(el, ctx) {
  const activity = await ctx.file('activity');
  const list = achievements({ entries: ctx.entries(), activity });
  el.className = 'page';
  el.innerHTML = `
    <section class="card block" aria-labelledby="ach-title">
      <h2 id="ach-title">${t('achievements.title')}</h2>
      ${medals(list)}
    </section>
    <section class="card block" id="card" aria-labelledby="card-title">
      <h2 id="card-title">${t('card.title')}</h2>
      <div id="card-box">${cardSection(ctx, activity)}</div>
    </section>`;
  el.addEventListener('click', (ev) => {
    const chip = ev.target.closest('[data-family]');
    if (!chip) return;
    family = chip.dataset.family;
    $('#card-box', el).innerHTML = cardSection(ctx, activity);
    $(`[data-family="${family}"]`, el)?.focus();
  });
  if (location.hash === '#card') $('#card', el).scrollIntoView();
}
