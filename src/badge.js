// Flat SVG badges, rendered without any font metrics library.

// Approximate advance widths for 11px Verdana, the de-facto badge font.
const WIDTHS = {
  narrow: "ijl.,:;'|!", // ~3.6
  slim: 'ftrI()[]-/ ', // ~4.6
  wide: 'mwMW@%', // ~10.5
};

export function textWidth(text) {
  let w = 0;
  for (const ch of String(text)) {
    if (WIDTHS.narrow.includes(ch)) w += 3.6;
    else if (WIDTHS.slim.includes(ch)) w += 4.6;
    else if (WIDTHS.wide.includes(ch)) w += 10.6;
    else if (/[A-Z]/.test(ch)) w += 7.8;
    else if (/[0-9]/.test(ch)) w += 7;
    else if (ch.charCodeAt(0) > 0x2e7f)
      w += 11; // CJK and other wide scripts
    else w += 6.6;
  }
  return w;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function percentColor(percent) {
  if (percent >= 100) return '#2f9e44';
  if (percent >= 90) return '#5c940d';
  if (percent >= 70) return '#a98600';
  if (percent >= 40) return '#d9730d';
  return '#c92a2a';
}

export function formatPercent(percent) {
  const p = Math.floor(percent * 10) / 10;
  return `${Number.isInteger(p) ? p : p.toFixed(1)}%`;
}

/** Render a two-part badge: [ label | message ]. */
export function renderBadge({ label, message, color = '#555' }) {
  const pad = 7;
  const lw = Math.round(textWidth(label) + pad * 2);
  const mw = Math.round(textWidth(message) + pad * 2);
  const w = lw + mw;
  const title = `${label}: ${message}`;
  const text = (x, value) =>
    `<text x="${x}" y="15" fill="#010101" fill-opacity=".3" aria-hidden="true">${esc(value)}</text>` +
    `<text x="${x}" y="14">${esc(value)}</text>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(title)}">` +
    `<title>${esc(title)}</title>` +
    `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
    `<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#r)">` +
    `<rect width="${lw}" height="20" fill="#3b3b3f"/>` +
    `<rect x="${lw}" width="${mw}" height="20" fill="${esc(color)}"/>` +
    `<rect width="${w}" height="20" fill="url(#s)"/>` +
    `</g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11" text-rendering="geometricPrecision">` +
    text(lw / 2, label) +
    text(lw + mw / 2, message) +
    `</g></svg>\n`
  );
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Albanian | 87% across 24 projects" */
export function overallBadge({ label, stats }) {
  return renderBadge({
    label,
    message: stats.components
      ? `${formatPercent(stats.percent)} across ${plural(stats.projects, 'project')}`
      : 'no projects yet',
    color: stats.components ? percentColor(stats.percent) : '#777',
  });
}

/** "Project name | sq 92%" */
export function projectBadge({ group, languageCode }) {
  return renderBadge({
    label: group.project.name,
    message: `${languageCode} ${formatPercent(group.stats.percent)}`,
    color: percentColor(group.stats.percent),
  });
}

export function badgeFileName(group) {
  const safe = (s) =>
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-');
  return `${safe(group.instance)}--${safe(group.project.slug)}.svg`;
}
