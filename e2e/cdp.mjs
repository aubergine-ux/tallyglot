// Tiny Chrome DevTools Protocol driver, enough to click through the app.
// No dependencies: uses the WebSocket built into Node 22.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function findChrome() {
  const names = [process.env.CHROME_BIN, 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  for (const name of names.filter(Boolean)) {
    const found = spawnSync('which', [name], { encoding: 'utf8' });
    if (found.status === 0) return found.stdout.trim();
  }
  return null;
}

export async function launch({ width = 1280, height = 900, scale = 1 } = {}) {
  const bin = findChrome();
  if (!bin) throw new Error('No Chrome or Chromium found. Set CHROME_BIN.');
  const profile = mkdtempSync(join(tmpdir(), 'tallyglot-e2e-'));
  const proc = spawn(bin, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    `--force-device-scale-factor=${scale}`,
    'about:blank',
  ]);
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not start')), 20000);
    proc.stderr.on('data', (chunk) => {
      buf += chunk;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.on('exit', () => reject(new Error('Chrome exited early')));
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 1;
  const waiting = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const slot = waiting.get(msg.id);
    if (!slot) return;
    waiting.delete(msg.id);
    if (msg.error) slot.reject(new Error(msg.error.message));
    else slot.resolve(msg.result);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const cmd = (method, params) => send(method, params, sessionId);
  await cmd('Page.enable');
  await cmd('Runtime.enable');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const page = {
    cmd,
    sleep,
    /** Run an expression in the page and return its (JSON-serialisable) value. */
    async eval(expression) {
      const res = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
      }
      return res.result.value;
    },
    async goto(url) {
      await cmd('Page.navigate', { url });
      await page.waitFor('document.readyState === "complete"');
    },
    async waitFor(expression, timeout = 10000) {
      const start = Date.now();
      for (;;) {
        if (await page.eval(`!!(${expression})`).catch(() => false)) return;
        if (Date.now() - start > timeout) throw new Error(`Timed out waiting for: ${expression}`);
        await sleep(50);
      }
    },
    click: (selector) =>
      page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('No element: ' + ${JSON.stringify(selector)}); el.click(); })()`),
    /** Set a form control's value the way typing would. */
    fill: (selector, value) =>
      page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('No element: ' + ${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`),
    text: (selector) => page.eval(`document.querySelector(${JSON.stringify(selector)})?.textContent.replace(/\\s+/g, ' ').trim() ?? null`),
    count: (selector) => page.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`),
    async screenshot() {
      const { data } = await cmd('Page.captureScreenshot', { format: 'png' });
      return Buffer.from(data, 'base64');
    },
    async close() {
      ws.close();
      proc.kill();
      await sleep(200);
      rmSync(profile, { recursive: true, force: true });
    },
  };
  return page;
}
