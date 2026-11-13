// Accessibility: text colours must keep WCAG AA contrast (4.5:1) on the
// surfaces they are used on, in both themes. Reads the tokens from the CSS.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CARD_THEMES } from '../src/card.js';

const css = readFileSync(new URL('../assets/styles.css', import.meta.url), 'utf8');

function tokens(block) {
  const out = {};
  for (const [, name, value] of block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi))
    out[name] = value;
  return out;
}
const light = tokens(
  css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)')),
);
const dark = tokens(css.slice(css.indexOf(":root[data-theme='dark']")).split('}')[0]);

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [text token, surface token]
const PAIRS = [
  ['ink', 'bg'],
  ['ink', 'surface'],
  ['ink-2', 'bg'],
  ['ink-2', 'surface'],
  ['ink-2', 'surface-2'],
  ['ink-2', 'track'],
  ['ink-3', 'bg'],
  ['ink-3', 'surface'],
  ['accent-ink', 'surface'],
  ['accent-ink', 'bg'],
  ['on-accent', 'accent-ink'],
  ['ok', 'surface'],
  ['warn-ink', 'warn-bg'],
  ['ink', 'info-bg'],
  ['bg', 'ink'],
];

for (const [name, theme] of [
  ['light', light],
  ['dark', dark],
]) {
  test(`contrast: ${name} theme text tokens meet AA`, () => {
    for (const [text, surface] of PAIRS) {
      const ratio = contrast(theme[text], theme[surface]);
      assert.ok(ratio >= 4.5, `--${text} on --${surface}: ${ratio.toFixed(2)}`);
    }
  });
}

test('contrast: the dark media query and the dark attribute define the same theme', () => {
  const media = tokens(
    css.slice(
      css.indexOf('@media (prefers-color-scheme: dark)'),
      css.indexOf(":root[data-theme='dark']"),
    ),
  );
  assert.deepEqual(media, dark);
});

test('contrast: profile card themes meet AA', () => {
  for (const [name, c] of Object.entries(CARD_THEMES)) {
    for (const key of ['title', 'text', 'muted']) {
      const ratio = contrast(c[key], c.bg);
      assert.ok(ratio >= 4.5, `${name}.${key}: ${ratio.toFixed(2)}`);
    }
    assert.ok(contrast(c.accent, c.bg) >= 3, `${name}.accent`); // graphics need 3:1
  }
});
