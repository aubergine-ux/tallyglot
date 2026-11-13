#!/usr/bin/env node
// Browser extension tests, in headless Chrome:
//  1. the unpacked extension loads and its background worker starts;
//  2. the panel renders for each kind of repository, on a page that imitates
//     GitHub's markup, with the extension API replaced by a stand-in.
//   node e2e/extension.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findChrome, launch } from './cdp.mjs';

if (!findChrome()) {
  console.log('Skipped: no Chrome or Chromium found.');
  process.exit(0);
}

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const messages = JSON.parse(await readFile(join(dir, '_locales/en/messages.json'), 'utf8'));
const detect = await readFile(join(dir, 'detect.js'), 'utf8');
const content = await readFile(join(dir, 'content.js'), 'utf8');

// A page shaped like a GitHub repository: README links and a file listing.
const text = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const repoPage = ({ links = [], files = [] }) => `<!doctype html><title>repo</title><body>
  <table>${files.map((f) => `<tr><td><a class="Link--primary" href="/o/r/blob/main/${encodeURIComponent(f)}">${text(f)}</a></td></tr>`).join('')}</table>
  <article class="markdown-body">${links.map((l) => `<a href="${l}">link</a>`).join('')}</article>`;

let current = {};
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(repoPage(current));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

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

const page = await launch({
  args: [`--load-extension=${dir}`, `--disable-extensions-except=${dir}`],
});

/** Load the imitation page and run the content script against it. */
async function visit(
  setup,
  { storage = { language: 'sq' }, answers = {}, href = 'https://github.com/o/r' } = {},
) {
  current = setup;
  await page.goto(`${origin}/o/r`);
  await page.eval(`(() => {
    const messages = ${JSON.stringify(messages)};
    const store = ${JSON.stringify(storage)};
    const answers = ${JSON.stringify(answers)};
    window.__sent = [];
    window.chrome = {
      i18n: { getMessage: (key, subs = []) => (messages[key]?.message || '').replace(/\\$(\\w+)\\$/g, (m, name) => {
        const p = messages[key].placeholders?.[name.toLowerCase()];
        return p ? subs[Number(p.content.slice(1)) - 1] : m;
      }) },
      storage: { local: {
        get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, store[k]])),
        set: async (items) => { Object.assign(store, items); window.__store = store; },
      } },
      runtime: { sendMessage: (message, reply) => { window.__sent.push(message); setTimeout(() => reply(answers[message.type] ?? null), 5); } },
    };
  })()`);
  await page.eval(detect);
  // The test page is not on github.com: tell the script which repository it is "on".
  await page.eval(
    `(() => { const real = TallyglotDetect.parseRepo; TallyglotDetect.parseRepo = () => real(${JSON.stringify(href)}); })()`,
  );
  await page.eval(content);
  await page.sleep(120);
}
const panel = () =>
  page.eval(`(() => {
    const root = document.getElementById('tallyglot-panel')?.shadowRoot;
    if (!root) return null;
    const go = root.querySelector('a.go');
    return {
      text: [...root.querySelectorAll('p')].map((p) => p.textContent),
      link: go ? [go.textContent, go.href] : null,
      bar: root.querySelector('.bar span')?.style.width || null,
      label: root.querySelector('.panel').getAttribute('aria-label'),
    };
  })()`);

try {
  await step('the unpacked extension loads and its background worker starts', async () => {
    let worker;
    for (let i = 0; i < 40 && !worker; i += 1) {
      const { targetInfos } = await page.browser('Target.getTargets');
      worker = targetInfos.find(
        // Chrome's own built-in extensions have workers too: look for ours.
        (t) => t.type === 'service_worker' && /^chrome-extension:.*\/background\.js$/.test(t.url),
      );
      if (!worker) await page.sleep(100);
    }
    if (!worker) {
      // Branded Google Chrome no longer loads unpacked extensions from the
      // command line; Chromium does. The panel tests below run either way.
      const version = execFileSync(findChrome(), ['--version'], { encoding: 'utf8' });
      if (/Google Chrome/.test(version)) {
        console.log('       (not checked: Google Chrome ignores --load-extension; use Chromium)');
        return;
      }
    }
    assert.ok(
      worker,
      'no extension service worker; the manifest was rejected or the worker crashed',
    );
  });

  const weblate = ['https://hosted.weblate.org/engage/trale/'];

  await step('Weblate project: status, progress bar and a Translate link', async () => {
    await visit(
      { links: weblate, files: ['lib'] },
      {
        answers: {
          files: ['lib/l10n/app_sq.arb'],
          status: {
            started: true,
            percent: 96.6,
            left: 1234,
            url: 'https://hosted.weblate.org/translate/trale/-/sq/',
          },
        },
      },
    );
    const p = await panel();
    assert.deepEqual(p.text, [
      'sq: 96.6% translated',
      '1,234 strings left',
      'Translated on Weblate',
    ]);
    assert.deepEqual(p.link, ['Translate', 'https://hosted.weblate.org/translate/trale/-/sq/']);
    assert.equal(p.bar, '96.6%');
    assert.equal(p.label, 'Tallyglot: Translation');
    const sent = await page.eval(`window.__sent`);
    assert.deepEqual(sent[0], {
      type: 'files',
      repo: { host: 'github.com', owner: 'o', repo: 'r', root: true },
    });
    assert.deepEqual(
      [sent[1].type, sent[1].language, sent[1].found.project],
      ['status', 'sq', 'trale'],
    );
  });

  await step('complete, not started, and status unavailable', async () => {
    await visit(
      { links: weblate },
      { answers: { status: { started: true, percent: 100, left: 0, url: null } } },
    );
    assert.deepEqual((await panel()).text.slice(0, 2), ['sq: 100% translated', 'Fully translated']);
    assert.equal((await panel()).link[1], 'https://hosted.weblate.org/engage/trale/');
    await visit(
      { links: weblate },
      { answers: { status: { started: false, percent: 0, left: 272, url: null } } },
    );
    assert.deepEqual((await panel()).text, ['sq has not been started', 'Translated on Weblate']);
    assert.equal((await panel()).link[0], 'Start translating');
    await visit({ links: ['https://crowdin.com/project/kestrel-notes'] }, { answers: {} });
    assert.deepEqual((await panel()).text, [
      'Translated on Crowdin',
      'Status is not available here',
    ]);
    assert.deepEqual((await panel()).link, [
      'Open on Crowdin',
      'https://crowdin.com/project/kestrel-notes',
    ]);
  });

  await step('no language chosen yet: asks for one, still links to the platform', async () => {
    await visit({ links: weblate }, { storage: {} });
    assert.deepEqual((await panel()).text, [
      'Translated on Weblate',
      'Choose your language to see its status',
    ]);
    assert.equal(
      (await page.eval(`window.__sent`)).some((m) => m.type === 'status'),
      false,
    );
  });

  await step('translation files without a platform, and a config file without a link', async () => {
    await visit({ files: ['po', 'src'] }); // the forge API gave nothing: the listing is used
    assert.deepEqual((await panel()).text, [
      'Translation files, but no translation platform',
      'This project keeps translations in the repository (po). Translating means opening a pull request.',
    ]);
    assert.equal((await panel()).link, null);
    await visit({}, { answers: { files: ['crowdin.yml', 'src/a.c'] } });
    assert.deepEqual((await panel()).text, [
      'Translated on Crowdin',
      'Uses Crowdin, but the project address is not linked from the README.',
    ]);
  });

  await step(
    'nothing to say: no panel; hidden repositories stay hidden; other pages are ignored',
    async () => {
      await visit({ files: ['src', 'README.md'] });
      assert.equal(await panel(), null);
      await visit(
        { links: weblate },
        { storage: { language: 'sq', 'hidden:github.com/o/r': true } },
      );
      assert.equal(await panel(), null);
      await visit({ links: weblate }, { href: 'https://github.com/o/r/issues/4' });
      assert.equal(await panel(), null);
      await visit({ links: weblate }, { href: 'https://github.com/settings/profile' });
      assert.equal(await panel(), null);
    },
  );

  await step(
    'Hide closes the panel and is remembered; page text cannot inject markup',
    async () => {
      await visit({ files: ['<img src=x onerror=alert(1)>.po'] });
      assert.equal(
        await page.eval(
          `document.getElementById('tallyglot-panel').shadowRoot.querySelectorAll('img').length`,
        ),
        0,
      );
      await page.eval(
        `document.getElementById('tallyglot-panel').shadowRoot.querySelector('button').click()`,
      );
      assert.equal(await panel(), null);
      assert.equal(await page.eval(`window.__store['hidden:github.com/o/r']`), true);
    },
  );
} finally {
  await page.close();
  server.close();
}

console.log(failed ? '\nExtension tests FAILED' : '\nExtension tests passed');
process.exit(failed ? 1 : 0);
