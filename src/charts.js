// SVG charts as strings: usable in the page (colours come from the theme's
// custom properties) and in files the Action writes (pass fixed colours).

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const r1 = (n) => Math.round(n * 10) / 10;

export const THEME_COLORS = {
  line: 'var(--accent)',
  grid: 'var(--line)',
  text: 'var(--ink-2)',
  surface: 'var(--surface)',
  levels: ['var(--track)', 'var(--heat-1)', 'var(--heat-2)', 'var(--heat-3)', 'var(--heat-4)'],
};

/** Round an axis range outwards to steps that read well. */
export function niceRange(min, max) {
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const step = [0.5, 1, 2, 5, 10, 20, 25, 50].find((s) => span / s <= 4) || 50;
  const lo = Math.max(0, Math.floor(min / step) * step);
  const hi = Math.min(100, Math.ceil(max / step) * step);
  const ticks = [];
  for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(r1(v));
  return { lo, hi: hi === lo ? lo + step : hi, ticks };
}

/**
 * Completion over time: one line, percent on the y axis.
 * points: [{ day: '2026-11-12', percent }]. Returns { svg, coords } where
 * coords are the plotted positions, for the hover layer.
 */
export function lineChart(
  points,
  { width = 720, height = 220, colors = THEME_COLORS, label = '', formatDay = (d) => d } = {},
) {
  const pad = { top: 14, right: 46, bottom: 26, left: 40 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const values = points.map((p) => p.percent);
  const { lo, hi, ticks } = niceRange(Math.min(...values), Math.max(...values));
  const t0 = Date.parse(points[0].day);
  const t1 = Date.parse(points[points.length - 1].day);
  const x = (day) => pad.left + (t1 === t0 ? w / 2 : ((Date.parse(day) - t0) / (t1 - t0)) * w);
  const y = (v) => pad.top + h - ((v - lo) / (hi - lo)) * h;
  const coords = points.map((p) => ({ ...p, x: r1(x(p.day)), y: r1(y(p.percent)) }));
  const path = coords.map((c, i) => `${i ? 'L' : 'M'}${c.x} ${c.y}`).join('');
  const last = coords[coords.length - 1];
  const grid = ticks
    .map(
      (v) =>
        `<line x1="${pad.left}" x2="${pad.left + w}" y1="${r1(y(v))}" y2="${r1(y(v))}" stroke="${colors.grid}" stroke-width="1"/>` +
        `<text x="${pad.left - 8}" y="${r1(y(v)) + 4}" text-anchor="end">${v}%</text>`,
    )
    .join('');
  const xLabels =
    coords.length > 1
      ? `<text x="${pad.left}" y="${height - 6}">${esc(formatDay(points[0].day))}</text>` +
        `<text x="${pad.left + w}" y="${height - 6}" text-anchor="end">${esc(formatDay(last.day))}</text>`
      : `<text x="${last.x}" y="${height - 6}" text-anchor="middle">${esc(formatDay(last.day))}</text>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}" class="chart-svg">` +
    `<g font-family="system-ui,sans-serif" font-size="11" fill="${colors.text}">${grid}${xLabels}</g>` +
    (coords.length > 1
      ? `<path d="${path}" fill="none" stroke="${colors.line}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
      : '') +
    `<circle cx="${last.x}" cy="${last.y}" r="4" fill="${colors.line}" stroke="${colors.surface}" stroke-width="2"/>` +
    `<text x="${last.x + 8}" y="${last.y + 4}" font-family="system-ui,sans-serif" font-size="12" font-weight="600" fill="${colors.text}">${last.percent}%</text>` +
    `<g class="chart-hover" style="display:none"><line y1="${pad.top}" y2="${pad.top + h}" stroke="${colors.text}" stroke-width="1"/><circle r="4" fill="${colors.line}" stroke="${colors.surface}" stroke-width="2"/></g>` +
    `</svg>`;
  return { svg, coords, width, height };
}

/**
 * Contribution calendar. `cal` comes from stats.calendar().
 * describe(cell) gives the tooltip text of a day.
 */
export function heatmap(
  cal,
  { colors = THEME_COLORS, cell = 11, gap = 3, label = '', months = [], describe } = {},
) {
  const step = cell + gap;
  const top = 16;
  const width = cal.columns.length * step - gap;
  const height = top + 7 * step - gap;
  let monthLabels = '';
  let seen = '';
  cal.columns.forEach((column, i) => {
    const first = column.find(Boolean);
    const month = first?.day.slice(0, 7);
    // Label a month at the first column that starts in it, if there is room.
    if (month && month !== seen && Number(first.day.slice(8)) <= 7 && i < cal.columns.length - 2) {
      monthLabels += `<text x="${i * step}" y="10">${esc(months[Number(month.slice(5)) - 1] || month.slice(5))}</text>`;
    }
    if (month) seen = month;
  });
  const cells = cal.columns
    .map((column, i) =>
      column
        .map((c, j) =>
          c
            ? `<rect x="${i * step}" y="${top + j * step}" width="${cell}" height="${cell}" rx="2.5" fill="${colors.levels[c.level]}" data-day="${c.day}" data-count="${c.count}">` +
              `<title>${esc(describe ? describe(c) : `${c.day}: ${c.count}`)}</title></rect>`
            : '',
        )
        .join(''),
    )
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(label)}" class="heatmap-svg">` +
    `<g font-family="system-ui,sans-serif" font-size="10" fill="${colors.text}">${monthLabels}</g>${cells}</svg>`
  );
}

/**
 * Horizontal bars, one per row: used for language coverage.
 * rows: [{ label, percent, note }]
 */
export function barChart(rows, { width = 560, colors = THEME_COLORS, title = '' } = {}) {
  const rowH = 22;
  const labelW = 150;
  const valueW = 52;
  const top = title ? 30 : 6;
  const barW = width - labelW - valueW - 16;
  const height = top + rows.length * rowH + 6;
  const body = rows
    .map((row, i) => {
      const y = top + i * rowH;
      const len = Math.max(row.percent > 0 ? 2 : 0, (barW * Math.min(100, row.percent)) / 100);
      return (
        `<text x="${labelW}" y="${y + 14}" text-anchor="end">${esc(row.label)}</text>` +
        `<rect x="${labelW + 8}" y="${y + 5}" width="${barW}" height="10" rx="5" fill="${colors.levels[0]}"/>` +
        (len
          ? `<rect x="${labelW + 8}" y="${y + 5}" width="${r1(len)}" height="10" rx="5" fill="${colors.line}"/>`
          : '') +
        `<text x="${width - 8}" y="${y + 14}" text-anchor="end" font-weight="600">${row.percent}%</text>`
      );
    })
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(title)}">` +
    (colors.background
      ? `<rect width="${width}" height="${height}" rx="10" fill="${colors.background}"/>`
      : '') +
    `<g font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="12" fill="${colors.text}">` +
    (title
      ? `<text x="12" y="19" font-size="13" font-weight="700" fill="${colors.ink || colors.text}">${esc(title)}</text>`
      : '') +
    `${body}</g></svg>\n`
  );
}
