#!/usr/bin/env node
// End-to-end test: drives the real app in headless Chrome against a fake Weblate.
//   node e2e/run.mjs        (needs Chrome or Chromium; set CHROME_BIN to choose one)

import assert from 'node:assert/strict';

import { findChrome, launch } from './cdp.mjs';
import { startApp, startWeblate } from './servers.mjs';

if (!findChrome()) {
  console.log('Skipped: no Chrome or Chromium found.');
  process.exit(0);
}

const weblate = await startWeblate();
const app = await startApp({
  '/tallyglot.config.json': { language: '', instances: [] },
  '/data/snapshot.json': null,
});
const page = await launch();
const apiCalls = () => weblate.state.requests.length;
const cards = () => page.eval(`[...document.querySelectorAll('.entry h3')].map((h) => h.textContent.trim())`);
const notices = () => page.eval(`[...document.querySelectorAll('#status .notice')].map((n) => n.textContent.replace(/\\s+/g, ' ').trim())`);
const settled = () => page.waitFor(`!document.querySelector('#refresh').disabled`);

let failed = false;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed = true;
    console.log(`  FAIL ${name}\n       ${String(err.message).split('\n').join('\n       ')}`);
  }
};

async function configure({ language = 'sq', user = 'alice', pinned = '', token = '' } = {}) {
  await page.click('#open-settings');
  await page.waitFor(`document.querySelector('#settings').open`);
  await page.fill('#settings [name="language"]', language);
  await page.fill('#settings .pair [name="usernames"]', user);
  if (!(await page.count(`.inst[data-url="${weblate.url}"]`))) {
    await page.fill('#new-url', weblate.url);
    await page.click('[data-action="add-instance"]');
    await page.waitFor(`document.querySelector('.inst[data-url="${weblate.url}"]')`);
  }
  const row = `.inst[data-url="${weblate.url}"]`;
  await page.fill(`${row} [name="pinned"]`, pinned);
  await page.fill(`${row} [name="token"]`, token);
  await page.eval(`document.querySelector('#settings-form').requestSubmit()`);
}

try {
  await step('first visit shows the welcome screen', async () => {
    await page.goto(app.url);
    await page.waitFor(`document.querySelector('.welcome')`);
    assert.match(await page.text('.welcome h1'), /Track your translations/);
    assert.equal(apiCalls(), 0);
  });

  await step('an empty language code cannot be saved', async () => {
    await page.click('#open-settings');
    await page.fill('#settings [name="language"]', '');
    await page.eval(`document.querySelector('#settings-form').requestSubmit()`);
    assert.equal(await page.eval(`document.querySelector('#settings').open`), true);
    await page.click('[data-action="close-settings"]');
  });

  await step('a bad instance address is rejected', async () => {
    await page.click('#open-settings');
    const before = await page.count('.inst');
    await page.fill('#new-url', 'not a url');
    await page.click('[data-action="add-instance"]');
    assert.equal(await page.count('.inst'), before);
    assert.match(await page.text('#toast'), /address/);
    await page.click('[data-action="close-settings"]');
  });

  await step('username + custom instance loads a card per component', async () => {
    await configure();
    await page.waitFor(`document.querySelectorAll('.entry').length === 3`);
    await settled();
    assert.deepEqual((await cards()).sort(), ['App', 'Docs', 'Ui']);
    assert.match(await page.text('.hero-number'), /^51\.2%$/); // 640 of 1250 strings
    assert.match(await page.text('.hero-caption'), /2 projects and 3 components/);
    assert.match(await page.text('.updated'), /Last updated/);
    assert.deepEqual(await notices(), []);
  });

  await step('cards show stats, approval and a link to the next string', async () => {
    const card = (name) => `[...document.querySelectorAll('.entry')].find((c) => c.querySelector('h3').textContent.trim() === '${name}')`;
    const ui = await page.eval(`${card('Ui')}.textContent.replace(/\\s+/g, ' ')`);
    assert.match(ui, /95% translated/);
    assert.match(ui, /6 untranslated · 4 need editing · 2 failing checks/);
    assert.match(ui, /Last activity yesterday/);
    assert.match(ui, /You: yesterday/);
    assert.equal(await page.eval(`${card('Ui')}.querySelector('.btn.primary').href`), `${weblate.url}/translate/alpha/ui/sq/?q=state:empty`);
    assert.match(await page.eval(`${card('App')}.textContent.replace(/\\s+/g, ' ')`), /100% translated 80% approved/);
    assert.match(await page.eval(`${card('App')}.querySelector('.entry-foot .btn').textContent`), /Review next string/);
    assert.match(await page.eval(`${card('Docs')}.textContent`), /Stale/);
    assert.equal(await page.eval(`${card('Ui')}.querySelector('.bar > span').style.width`), '95%');
  });

  await step('sorting', async () => {
    assert.deepEqual(await cards(), ['Ui', 'Docs', 'App']); // closest to 100%, finished last
    await page.fill('#sort', 'least');
    assert.deepEqual(await cards(), ['Docs', 'Ui', 'App']);
    await page.fill('#sort', 'most');
    assert.deepEqual(await cards(), ['App', 'Ui', 'Docs']);
    await page.fill('#sort', 'stalest');
    assert.deepEqual(await cards(), ['Docs', 'App', 'Ui']);
    await page.fill('#sort', 'closest');
  });

  await step('filters and search', async () => {
    await page.click('[data-toggle="stale"]');
    assert.deepEqual(await cards(), ['Docs']);
    await page.click('[data-toggle="stale"]');
    await page.click('[data-toggle="unfinished"]');
    assert.deepEqual(await cards(), ['Ui', 'Docs']);
    await page.click('[data-toggle="unfinished"]');
    await page.fill('#query', 'BETA');
    assert.deepEqual(await cards(), ['App']);
    await page.fill('#query', 'zzz');
    assert.match(await page.text('.none'), /No components match/);
    await page.fill('#query', '');
    assert.equal((await cards()).length, 3);
  });

  await step('badge section offers markdown for static badge files', async () => {
    assert.match(await page.text('.badge-row code'), /^\[!\[Albanian translation progress\]\(http.*\/badges\/overall\.svg\)\]/);
    assert.match(decodeURIComponent(await page.eval(`document.querySelector('.badge-row img').src`)), /51\.2% across 2 projects/);
    assert.equal(await page.count('.badges details .badge-row'), 2);
  });

  await step('a reload is served from the cache without API calls', async () => {
    const before = apiCalls();
    await page.goto(app.url);
    await page.waitFor(`document.querySelectorAll('.entry').length === 3`);
    await page.sleep(300);
    assert.equal(apiCalls(), before);
    assert.match(await page.text('.updated'), /Last updated/);
  });

  await step('rate limit: keeps the data and explains', async () => {
    weblate.state.mode = 'limit';
    await page.click('#refresh');
    await page.waitFor(`document.querySelector('#status .notice.warn')`);
    await settled();
    assert.match((await notices()).join(' '), /rate limit reached.*Try again in 30 minutes.*API token/);
    assert.equal((await cards()).length, 3);
    weblate.state.mode = 'ok';
    const before = apiCalls();
    await page.goto(app.url); // limited instances are left alone until the limit resets
    await page.waitFor(`document.querySelectorAll('.entry').length === 3`);
    await page.sleep(300);
    assert.equal(apiCalls(), before);
    assert.match((await notices()).join(' '), /rate limit reached/);
  });

  await step('manual refresh recovers; pins and tokens are honoured', async () => {
    await configure({ pinned: 'gamma/extra, gamma/nope', token: 'wlu_test' });
    await page.waitFor(`document.querySelectorAll('.entry').length === 4`);
    await settled();
    assert.equal((await cards())[0], 'Extra'); // pinned first
    assert.match(await page.text('.entry'), /Pinned/);
    assert.deepEqual(await notices(), []);
    assert.equal(weblate.state.requests.at(-1).auth, 'Token wlu_test');
  });

  await step('server errors keep the previous data', async () => {
    weblate.state.mode = 'error';
    await page.click('#refresh');
    await page.waitFor(`document.querySelector('#status .notice.warn')`);
    await settled();
    assert.match((await notices()).join(' '), /HTTP 500/);
    assert.equal((await cards()).length, 4);
    weblate.state.mode = 'ok';
  });

  await step('slow network shows progress, then finishes', async () => {
    await configure({ user: 'alice', pinned: '' }); // new fingerprint -> full refetch
    weblate.state.delay = 400;
    await page.waitFor(`document.querySelector('#refresh').disabled`);
    await page.waitFor(`/Looking for your translations|Refreshing/.test(document.querySelector('#app').textContent)`);
    weblate.state.delay = 0;
    await page.waitFor(`document.querySelectorAll('.entry').length === 3`);
    await settled();
  });

  await step('unknown username gives a helpful empty state', async () => {
    await configure({ user: 'ghost' });
    await page.waitFor(`/Nothing found yet/.test(document.querySelector('#app').textContent)`);
    assert.match(await page.text('.welcome'), /Check the spelling/);
  });

  await step('unreachable instance is reported', async () => {
    await page.click('#open-settings');
    await page.fill('#new-url', 'http://127.0.0.1:9');
    await page.click('[data-action="add-instance"]');
    await page.waitFor(`document.querySelector('.inst[data-url="http://127.0.0.1:9"]')`);
    await page.fill('#settings .pair [name="usernames"]', 'alice');
    await page.eval(`document.querySelector('#settings-form').requestSubmit()`);
    await page.waitFor(`/could not be reached/.test(document.querySelector('#status').textContent)`);
    await page.waitFor(`document.querySelectorAll('.entry').length === 3`);
    assert.equal(await page.count('.chip[data-instance]'), 0); // only one instance has data
  });

  await step('copy config produces committable JSON without tokens', async () => {
    await page.click('#open-settings');
    await page.eval(`(() => { window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; })()`);
    await page.click('[data-action="copy-config"]');
    await page.waitFor(`window.__copied`);
    const copied = JSON.parse(await page.eval(`window.__copied`));
    assert.equal(copied.language, 'sq');
    assert.deepEqual(copied.usernames, ['alice']);
    assert.ok(copied.instances.some((i) => i.url === weblate.url));
    assert.ok(!JSON.stringify(copied).includes('wlu_'));
    await page.click('[data-action="close-settings"]');
  });

  await step('theme toggle persists', async () => {
    await page.click('#theme');
    const theme = await page.eval(`document.documentElement.dataset.theme`);
    assert.ok(['light', 'dark'].includes(theme));
    await page.goto(app.url);
    assert.equal(await page.eval(`document.documentElement.dataset.theme`), theme);
  });

  await step('reset returns to the repository config', async () => {
    await page.click('#open-settings');
    await page.click('[data-action="reset-settings"]');
    await page.waitFor(`document.querySelector('.welcome h1')`);
    assert.equal(await page.eval(`localStorage.getItem('tallyglot:settings')`), null);
  });

  await step('demo mode renders sample data without touching any API', async () => {
    const before = apiCalls();
    await page.goto(`${app.url}/?demo`);
    await page.waitFor(`document.querySelectorAll('.entry').length === 16`);
    assert.equal(await page.eval(`document.querySelector('#refresh').disabled`), true);
    assert.equal(await page.count('.chip[data-instance]'), 4);
    await page.click('.chip[data-instance="fedora"]');
    assert.equal((await cards()).length, 4);
    assert.equal(apiCalls(), before);
  });

  await step('no horizontal overflow at phone width', async () => {
    await page.cmd('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 1, mobile: true });
    await page.goto(`${app.url}/?demo`);
    await page.waitFor(`document.querySelectorAll('.entry').length === 16`);
    assert.equal(await page.eval(`document.documentElement.scrollWidth <= window.innerWidth`), true);
  });
} finally {
  await page.close();
  app.close();
  weblate.close();
}

console.log(failed ? '\nEnd-to-end tests FAILED' : '\nEnd-to-end tests passed');
process.exit(failed ? 1 : 0);
