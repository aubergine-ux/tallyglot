// Interface translations. Strings live in locales/<code>.json in the i18next
// JSON v4 format (nested keys, {{variables}}, _one/_other plural suffixes),
// which Weblate and most other platforms can edit directly.

let strings = {};
let fallback = {};
let locale = 'en';
let rules = new Intl.PluralRules('en');
let numbers = new Intl.NumberFormat('en');

export const currentLocale = () => locale;

const lookup = (dict, key) => {
  let node = dict;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
};

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Pick the best available locale for a list of preferred language tags. */
export function matchLocale(available, preferred) {
  const codes = Object.keys(available);
  const norm = (c) => String(c).toLowerCase().replace(/_/g, '-');
  for (const want of preferred.filter(Boolean)) {
    const exact = codes.find((c) => norm(c) === norm(want));
    if (exact) return exact;
    const base = codes.find((c) => norm(c) === norm(want).split('-')[0]);
    if (base) return base;
  }
  return 'en';
}

/** Install the dictionaries. `english` is used wherever `dict` lacks a key. */
export function setLocale(code, dict, english) {
  locale = code;
  strings = dict || {};
  fallback = english || dict || {};
  try {
    rules = new Intl.PluralRules(code.replace(/_/g, '-'));
    numbers = new Intl.NumberFormat(code.replace(/_/g, '-'));
  } catch {
    rules = new Intl.PluralRules('en');
    numbers = new Intl.NumberFormat('en');
  }
}

function resolve(key, vars) {
  const find = (dict, plural) =>
    (vars && typeof vars.count === 'number' && lookup(dict, `${key}_${plural}`)) ||
    lookup(dict, key);
  const count = vars?.count;
  return (
    find(strings, typeof count === 'number' ? rules.select(count) : '') ??
    find(strings, 'other') ??
    find(fallback, count === 1 ? 'one' : 'other') ??
    find(fallback, 'other') ??
    key
  );
}

function fill(template, vars, escape) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => {
    const value = vars?.[name];
    if (value === undefined || value === null) return '';
    if (typeof value === 'number') return numbers.format(value);
    if (typeof value === 'object' && 'html' in value) return escape ? value.html : '';
    return escape ? escapeHtml(value) : String(value);
  });
}

/**
 * Translate to HTML. Variables are escaped; pass { html } to insert markup.
 * Numbers are formatted for the locale and `count` selects the plural form.
 */
export const t = (key, vars) => fill(resolve(key, vars), vars, true);

/** Translate to plain text, for textContent, titles and files. */
export const tt = (key, vars) => fill(resolve(key, vars), vars, false);

/** Format a number the way the interface language writes it. */
export const formatNumber = (n) => numbers.format(n);
