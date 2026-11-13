#!/usr/bin/env node
// Regenerates the README images from the demo data, with headless Chrome:
//   docs/screenshots/<page>-<light|dark>.png   and   docs/screenshots/tour.gif
// The GIF needs ffmpeg on the PATH; without it only the PNGs are made.
//   node scripts/make-screenshots.mjs

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch } from '../e2e/cdp.mjs';
import { startApp } from '../e2e/servers.mjs';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots');
await mkdir(out, { recursive: true });
const app = await startApp();
const page = await launch({ scale: 1 });

const viewport = (width, height, scale, mobile = false) =>
  page.cmd('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: scale,
    mobile,
  });
async function open(query, ready) {
  await page.goto(`${app.url}/${query}`);
  await page.waitFor(ready);
  await page.sleep(1300); // fonts, images, and the count-up on the year in review
}
const save = async (name) => writeFile(join(out, name), await page.screenshot());

// [name, query, ready, width, height, scale, mobile]
const shots = [
  ['dashboard', '?demo', `document.querySelectorAll('.entry').length === 16`, 1280, 1010, 2],
  ['stats', '?demo&view=stats', `document.querySelector('#card img')`, 1280, 1010, 1.5],
  ['glossary', '?demo&view=glossary', `document.querySelector('.terms')`, 1280, 900, 1.5],
  ['review', '?demo&view=review', `document.querySelector('.queue')`, 1280, 900, 1.5],
  ['find', '?demo&view=find', `document.querySelector('.find-table')`, 1280, 900, 1.5],
  ['team', '?demo&view=team', `document.querySelector('#team-board-body table')`, 1280, 900, 1.5],
  ['wrapped', '?demo&view=wrapped', `document.querySelector('.wrap-grid')`, 1280, 900, 1.5],
  [
    'portfolio',
    '?demo&view=portfolio',
    `document.querySelector('.portfolio-projects')`,
    1280,
    900,
    1.5,
  ],
  ['mobile', '?demo', `document.querySelectorAll('.entry').length === 16`, 390, 844, 2, true],
];

try {
  for (const [name, query, ready, width, height, scale, mobile] of shots) {
    for (const theme of ['light', 'dark']) {
      await viewport(width, height, scale, !!mobile);
      await open(`${query}&theme=${theme}`, ready);
      // The sample-data notice is not part of the product.
      await page.eval(`document.querySelector('.notice.info')?.remove()`);
      await save(`${name}-${theme}.png`);
      console.log(`${name}-${theme}.png`);
    }
  }

  // ---- the tour: a walk through the newest pages ----
  if (spawnSync('ffmpeg', ['-version']).status !== 0) {
    console.log('ffmpeg not found: tour.gif was not regenerated.');
  } else {
    const frames = await mkdtemp(join(tmpdir(), 'tallyglot-tour-'));
    let n = 0;
    const hold = async (seconds) => {
      const png = await page.screenshot();
      for (let i = 0; i < Math.round(seconds * 5); i += 1) {
        await writeFile(join(frames, `${String((n += 1)).padStart(4, '0')}.png`), png);
      }
    };
    const scrollTo = async (selector) => {
      await page.eval(
        `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'start' }); scrollBy(0, -16)`,
      );
      await page.sleep(250);
    };
    await viewport(900, 560, 1);
    const go = async (query, ready) => {
      await open(`${query}&theme=light`, ready);
      await page.eval(`document.querySelector('.notice.info')?.remove()`);
    };
    await go('?demo', `document.querySelectorAll('.entry').length === 16`);
    await hold(1.6);
    await go('?demo&view=stats', `document.querySelector('#card img')`);
    await hold(1.6);
    await scrollTo('#chart-title');
    await hold(1.4);
    await scrollTo('#card');
    await hold(1.6);
    await go('?demo&view=glossary', `document.querySelector('.terms')`);
    await hold(1.4);
    await page.click('.term:first-child .variant:nth-child(1) input');
    await page.sleep(200);
    await hold(1.4);
    await go('?demo&view=review', `document.querySelector('.queue')`);
    await hold(1.6);
    await go('?demo&view=find', `document.querySelector('.find-table')`);
    await hold(1.6);
    await go('?demo&view=team', `document.querySelector('#team-board-body table')`);
    await hold(1.4);
    await go('?demo&view=wrapped', `document.querySelector('.wrap-grid')`);
    await hold(1.8);
    await go('?demo&view=portfolio', `document.querySelector('.portfolio-projects')`);
    await hold(1.8);

    const gif = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-framerate',
        '5',
        '-i',
        join(frames, '%04d.png'),
        '-vf',
        'split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
        join(out, 'tour.gif'),
      ],
      { encoding: 'utf8' },
    );
    if (gif.status !== 0) console.log(`ffmpeg failed: ${gif.stderr}`);
    else console.log(`tour.gif (${n} frames)`);
    await rm(frames, { recursive: true });
  }
} finally {
  await page.close();
  app.close();
}
