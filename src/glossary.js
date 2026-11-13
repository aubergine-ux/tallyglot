// Personal glossary and consistency checker. Built from the user's own
// translations (the same Weblate change history that feeds the calendar):
// short source strings are treated as terms, and a term with more than one
// translation across projects is flagged.

import { parseTranslationUrl } from './core.js';

const MAX_WORDS = 4;
const MAX_LENGTH = 40;
const MAX_UNITS = 8000;

export const emptyGlossary = () => ({
  version: 1,
  updatedAt: null,
  sources: {}, // instance id -> fingerprint
  units: {}, // "<instance>:<unit id>" -> [source, target, "project/component", changed]
});

/** Is this source string short enough to be a term rather than a sentence? */
export function isTerm(source) {
  const text = String(source || '').trim();
  if (!text || text.length > MAX_LENGTH || !/\p{L}/u.test(text)) return false;
  if (/[\n\x1e]|%[sd@]|\{[^}]*\}|<[^>]+>/.test(text)) return false; // placeholders, markup, plurals
  return text.split(/\s+/).length <= MAX_WORDS;
}

/**
 * Key that makes "Settings", "settings…", "&Settings" and "Settings:" one term:
 * case, accelerator marks, surrounding punctuation and spacing are ignored.
 */
export function normalizeTerm(text) {
  return String(text || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[&_](?=\p{L})/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'“”‘’«»(]+|[\s"'“”‘’«»):.…!?]+$/gu, '')
    .trim();
}

/** Record the latest translation of every short string among `changes`. */
export function collectTerms(glossary, instanceId, changes) {
  for (const change of changes) {
    const source = change.details?.source;
    const target = change.target;
    const id = /\/units\/(\d+)\/?$/.exec(change.unit || '')?.[1];
    const parsed = parseTranslationUrl(change.translation);
    if (!id || !parsed || !target || !isTerm(source) || /\x1e/.test(target)) continue;
    const key = `${instanceId}:${id}`;
    const stamp = change.timestamp ? new Date(change.timestamp).toISOString() : '';
    const prev = glossary.units[key];
    if (prev && prev[3] > stamp) continue;
    glossary.units[key] = [
      String(source).trim(),
      String(target).trim(),
      `${parsed.project}/${parsed.component}`,
      stamp,
    ];
  }
  const keys = Object.keys(glossary.units);
  if (keys.length > MAX_UNITS) {
    keys
      .sort((a, b) => glossary.units[a][3].localeCompare(glossary.units[b][3]))
      .slice(0, keys.length - MAX_UNITS)
      .forEach((k) => delete glossary.units[k]);
  }
  return glossary;
}

export function dropGlossaryInstance(glossary, instanceId) {
  for (const key of Object.keys(glossary.units)) {
    if (key.startsWith(`${instanceId}:`)) delete glossary.units[key];
  }
  delete glossary.sources[instanceId];
}

/**
 * Group the recorded units into terms.
 * @param {object} glossary  as stored
 * @param {object} preferred normalized term -> preferred translation
 * @returns {{key: string, term: string, variants: {target: string, count: number,
 *   projects: string[], units: {key: string, path: string}[]}[], consistent: boolean,
 *   preferred: string|null, uses: number}[]}
 */
export function buildTerms(glossary, preferred = {}) {
  const terms = new Map();
  for (const [key, [source, target, path]] of Object.entries(glossary?.units || {})) {
    const norm = normalizeTerm(source);
    if (!norm) continue;
    const term = terms.get(norm) || { key: norm, forms: new Map(), variants: new Map(), uses: 0 };
    term.forms.set(source, (term.forms.get(source) || 0) + 1);
    const variantKey = normalizeTerm(target);
    const variant = term.variants.get(variantKey) || {
      forms: new Map(),
      count: 0,
      projects: new Set(),
      units: [],
    };
    variant.forms.set(target, (variant.forms.get(target) || 0) + 1);
    variant.count += 1;
    variant.projects.add(`${key.split(':')[0]}:${path.split('/')[0]}`);
    variant.units.push({ key, path });
    term.variants.set(variantKey, variant);
    term.uses += 1;
    terms.set(norm, term);
  }
  // The spelling shown: the most frequent one, and among equals the plainest
  // ("Settings" rather than "&Settings" or "Settings…").
  const noise = (text) => text.replace(/[\p{L}\p{N}\s]/gu, '').length;
  const commonest = (forms) =>
    [...forms].sort(
      (a, b) => b[1] - a[1] || noise(a[0]) - noise(b[0]) || a[0].localeCompare(b[0]),
    )[0][0];
  return [...terms.values()]
    .map((term) => {
      const variants = [...term.variants.values()]
        .map((v) => ({
          target: commonest(v.forms),
          count: v.count,
          projects: [...v.projects].sort(),
          units: v.units.sort((a, b) => a.path.localeCompare(b.path)),
        }))
        .sort((a, b) => b.count - a.count || a.target.localeCompare(b.target));
      const choice = preferred[term.key];
      return {
        key: term.key,
        term: commonest(term.forms),
        variants,
        consistent: variants.length === 1,
        preferred: variants.some((v) => v.target === choice) ? choice : null,
        uses: term.uses,
      };
    })
    .sort(
      (a, b) =>
        a.consistent - b.consistent ||
        b.variants.length - a.variants.length ||
        b.uses - a.uses ||
        a.term.localeCompare(b.term),
    );
}

/**
 * Term pairs for export: the preferred translation, else the only one, else
 * (unless `strict`) the most used one.
 */
export function exportPairs(terms, { strict = false } = {}) {
  return terms
    .map((term) => {
      const target =
        term.preferred ||
        (term.consistent ? term.variants[0].target : strict ? null : term.variants[0].target);
      return target ? { source: term.term, target } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.source.localeCompare(b.source));
}

const csvCell = (value) => {
  const text = String(value);
  // Leading = + - @ would be run as a formula by spreadsheet programs.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** CSV with a source,target header: what Weblate's glossary import expects. */
export function toCsv(pairs) {
  return `${['source,target', ...pairs.map((p) => `${csvCell(p.source)},${csvCell(p.target)}`)].join('\r\n')}\r\n`;
}

const xml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c],
  );

/** TBX (TermBase eXchange), the format glossaries travel in between tools. */
export function toTbx(pairs, { sourceLanguage = 'en', language, title = 'Tallyglot glossary' }) {
  const lang = (code) => xml(String(code).replace(/_/g, '-'));
  const entries = pairs
    .map(
      (p, i) =>
        `      <termEntry id="t${i + 1}">\n` +
        `        <langSet xml:lang="${lang(sourceLanguage)}"><tig><term>${xml(p.source)}</term></tig></langSet>\n` +
        `        <langSet xml:lang="${lang(language)}"><tig><term>${xml(p.target)}</term></tig></langSet>\n` +
        `      </termEntry>`,
    )
    .join('\n');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE martif SYSTEM "TBXcoreStructV02.dtd">\n` +
    `<martif type="TBX" xml:lang="${lang(sourceLanguage)}">\n` +
    `  <martifHeader>\n    <fileDesc>\n      <titleStmt><title>${xml(title)}</title></titleStmt>\n` +
    `      <sourceDesc><p>Exported by Tallyglot from the translator's own work</p></sourceDesc>\n` +
    `    </fileDesc>\n  </martifHeader>\n  <text>\n    <body>\n${entries}${entries ? '\n' : ''}    </body>\n  </text>\n</martif>\n`
  );
}
