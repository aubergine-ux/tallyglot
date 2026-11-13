#!/usr/bin/env node
// Renders the PNG app icons from assets/icon.svg with headless Chrome.
// Run after changing the icon: node scripts/make-icons.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch } from '../e2e/cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(join(root, 'assets', 'icon.svg'), 'utf8');
const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

// [file, size, share of the canvas the artwork fills, background]
// Maskable icons keep the artwork inside the central 80% "safe zone".
const icons = [
  ['icon-192.png', 192, 1, 'transparent'],
  ['icon-512.png', 512, 1, 'transparent'],
  ['icon-maskable-512.png', 512, 0.74, '#e8590c'],
  ['../extension/icon-48.png', 48, 1, 'transparent'],
  ['../extension/icon-128.png', 128, 1, 'transparent'],
];

const page = await launch();
try {
  for (const [file, size, share, background] of icons) {
    await page.cmd('Emulation.setDeviceMetricsOverride', {
      width: size,
      height: size,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.cmd('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });
    const html = `<body style="margin:0;display:grid;place-items:center;width:${size}px;height:${size}px;background:${background}"><img src="${uri}" width="${size * share}" height="${size * share}"></body>`;
    await page.goto(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
    await page.sleep(150);
    await writeFile(join(root, 'assets', file), await page.screenshot());
    console.log(join('assets', file));
  }
} finally {
  await page.close();
}
