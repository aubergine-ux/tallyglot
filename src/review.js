// Review queue: everything that needs the translator's attention, across
// platforms. Counts come with every refresh; the strings behind a count are
// fetched on demand, one request per list.

export const REVIEW_KINDS = ['checks', 'suggestions', 'editing', 'comments'];

const COUNT = {
  checks: (e) => e.failing || 0,
  suggestions: (e) => e.suggestions || 0,
  editing: (e) => e.fuzzy || 0,
  comments: (e) => e.comments || 0,
};

// Weblate search expressions (docs.weblate.org/en/latest/user/search.html)
const WEBLATE_QUERY = {
  checks: 'has:check',
  suggestions: 'has:suggestion',
  editing: 'state:needs-editing',
  comments: 'has:comment',
};

// Pontoon's status filter; it has no "needs editing" state and no comment filter.
const PONTOON_STATUS = { checks: 'errors,warnings', suggestions: 'unreviewed' };

/** Address of the editor, filtered to the strings of one kind. */
export function reviewUrl(entry, kind) {
  const platform = entry.platform || 'weblate';
  if (platform === 'weblate' && entry.translateUrl) {
    return `${entry.translateUrl}?q=${encodeURIComponent(WEBLATE_QUERY[kind])}`;
  }
  if (platform === 'pontoon' && PONTOON_STATUS[kind] && entry.translateUrl) {
    return `${entry.translateUrl}?status=${PONTOON_STATUS[kind]}`;
  }
  return entry.translateUrl || entry.webUrl || '';
}

/** Can the individual strings be listed (rather than only linked to)? */
export const canListStrings = (entry) => (entry.platform || 'weblate') === 'weblate';

/**
 * One item per component and kind with something waiting, biggest first.
 * @returns {{id: string, kind: string, entry: object, count: number, url: string}[]}
 */
export function reviewItems(entries, kinds = REVIEW_KINDS) {
  const items = [];
  for (const entry of entries) {
    for (const kind of kinds) {
      const count = COUNT[kind](entry);
      if (count > 0) {
        items.push({ id: `${entry.id}#${kind}`, kind, entry, count, url: reviewUrl(entry, kind) });
      }
    }
  }
  return items.sort(
    (a, b) =>
      b.count - a.count ||
      a.entry.project.name.localeCompare(b.entry.project.name) ||
      a.id.localeCompare(b.id),
  );
}

/** Total per kind, for the tiles. */
export function reviewTotals(entries) {
  return Object.fromEntries(
    REVIEW_KINDS.map((kind) => [kind, entries.reduce((n, e) => n + COUNT[kind](e), 0)]),
  );
}

const first = (value) => (Array.isArray(value) ? value[0] : value) || '';

/**
 * The strings behind one item, each with a link to the editor (Weblate only).
 * @returns {Promise<{strings: {source: string, target: string, context: string, url: string}[], more: number}>}
 */
export async function loadStrings(client, item, { limit = 20 } = {}) {
  const page = await client.get(`${item.entry.apiUrl}units/`, {
    q: WEBLATE_QUERY[item.kind],
    page_size: limit,
  });
  const strings = (page.results || []).map((u) => ({
    source: first(u.source),
    target: first(u.target),
    context: u.context || '',
    url: u.web_url || item.url,
  }));
  return { strings, more: Math.max(0, (page.count ?? strings.length) - strings.length) };
}
