// Small DOM and formatting helpers shared by the dashboard and every page.

import { currentLocale, formatNumber, tt } from './i18n.js';

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const num = (n) => formatNumber(n);

const intlLocale = () => currentLocale().replace(/_/g, '-');

export function ago(iso) {
  if (!iso) return tt('time.never');
  const rtf = new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto' });
  const sec = (new Date(iso).getTime() - Date.now()) / 1000;
  const steps = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(sec) >= size) return rtf.format(Math.round(sec / size), unit);
  }
  return tt('time.justNow');
}

export const fullDate = (iso) =>
  iso
    ? new Date(iso).toLocaleString(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' })
    : '';

export const shortDate = (iso, opts = { dateStyle: 'medium' }) =>
  iso ? new Date(iso).toLocaleDateString(intlLocale(), { timeZone: 'UTC', ...opts }) : '';

export function toast(message) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}

export async function copyText(text, done = tt('toast.copied')) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
    return true;
  } catch {
    toast(tt('toast.copyFailed'));
    return false;
  }
}

/** Hand the visitor a file made in the browser. */
export function download(name, content, type = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function fetchJson(path) {
  try {
    const res = await fetch(path, { cache: 'no-cache' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export const svgUri = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** Address of the folder the app is served from, with a trailing slash. */
export const siteUrl = () => new URL('.', location.href).href;

/**
 * The year whose review is worth announcing on `today`: the current year in
 * December, the one just ended in January, otherwise none.
 */
export function reviewSeason(today = new Date()) {
  const month = today.getUTCMonth();
  if (month === 11) return today.getUTCFullYear();
  if (month === 0) return today.getUTCFullYear() - 1;
  return null;
}
