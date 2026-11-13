#!/usr/bin/env node
// End-to-end test of everything beyond the dashboard: platforms, the pages,
// translations of the interface, offline use and accessibility.
//   node e2e/pages.mjs      (needs Chrome or Chromium; set CHROME_BIN to choose one)

import assert from 'node:assert/strict';

import { findChrome, launch } from './cdp.mjs';
import { startApp, startCrowdin, startWeblate } from './servers.mjs';

if (!findChrome()) {
  console.log('Skipped: no Chrome or Chromium found.');
  process.exit(0);
}

const weblate = await startWeblate();
const crowdin = await startCrowdin();
const overrides = {
  '/tallyglot.config.json': {
    language: 'sq',
    usernames: ['alice'],
    instances: [
      { url: weblate.url, name: 'Test Weblate' },
      { platform: 'crowdin', url: crowdin.url, projects: ['4242'] },
      { platform: 'pontoon', projects: ['firefox'] },
    ],
  },
  '/data/snapshot.json': null,
  // The repository's own records belong to its owner, not to this test's "alice".
  '/data/activity.json': null,
  '/data/alerts.json': null,
  '/data/findwork.json': null,
  '/data/history/index.json': null,
  '/data/glossary.json': {
    version: 1,
    units: {
      'x:1': ['Save', 'Ruaj', 'alpha/ui', '2026-01-01T00:00:00.000Z'],
      'x:2': ['Save', 'Ruaje', 'alpha/docs', '2026-01-02T00:00:00.000Z'],
    },
  },
  '/locales/index.json': { en: 'English', xx: 'Test language' },
  '/locales/xx.json': {
    nav: { stats: 'Statistikz', dashboard: 'Dashbord' },
    count: { projects_one: '{{count}} projekt', projects_other: '{{count}} projektz' },
  },
};
let app = await startApp(overrides);
const page = await launch();
await page.cmd('Log.enable');

const errors = [];
const watch = `window.__errors ||= []; window.addEventListener('error', (e) => __errors.push(e.message)); window.addEventListener('unhandledrejection', (e) => __errors.push(String(e.reason)));`;
await page.cmd('Page.addScriptToEvaluateOnNewDocument', { source: watch });
const collect = async () => errors.push(...(await page.eval(`window.__errors.splice(0)`)));

const texts = (selector) =>
  page.eval(
    `[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => el.textContent.replace(/\\s+/g, ' ').trim())`,
  );
const open = async (query, ready) => {
  await page.goto(`${app.url}/${query}`);
  await page.waitFor(ready);
  await collect();
};
const key = async (name, modifiers = 0) => {
  for (const type of ['keyDown', 'keyUp']) {
    await page.cmd('Input.dispatchKeyEvent', { type, key: name, code: name, modifiers });
  }
};
const settled = () => page.waitFor(`!document.querySelector('#refresh').disabled`);

let failed = false;
const step = async (name, fn) => {
  try {
    await fn();
    await collect();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed = true;
    console.log(`  FAIL ${name}\n       ${String(err.message).split('\n').join('\n       ')}`);
  }
};

try {
  /* ---------- 1. platforms ---------- */

  await step(
    'platforms: Weblate loads, Crowdin asks for a token, Pontoon waits for the Action',
    async () => {
      await open('', `document.querySelectorAll('.entry').length === 3`);
      await settled();
      const notes = (await texts('#status .notice')).join(' | ');
      assert.match(notes, /Crowdin needs an API token/);
      assert.match(notes, /Pontoon cannot be read from a browser/);
      assert.equal(crowdin.state.requests.length, 0, 'no request without a token');
      assert.deepEqual([...new Set(await texts('.tag.platform'))], ['Test Weblate']);
    },
  );

  await step('platforms: a token in Settings brings the Crowdin project in', async () => {
    await page.click('#open-settings');
    await page.waitFor(`document.querySelector('.inst[data-platform="crowdin"] [name="token"]')`);
    assert.match(await page.text('.inst[data-platform="crowdin"] small'), /Personal access tokens/);
    assert.equal(await page.count('.inst[data-platform="pontoon"] [name="token"]'), 0);
    await page.fill('.inst[data-platform="crowdin"] [name="token"]', 'crowdin-secret');
    await page.eval(`document.querySelector('#settings-form').requestSubmit()`);
    await page.waitFor(`document.querySelectorAll('.entry').length === 4`);
    await settled();
    assert.equal(crowdin.state.requests.at(-1).auth, 'Bearer crowdin-secret');
    const card = `[...document.querySelectorAll('.entry')].find((c) => /Kestrel Notes/.test(c.textContent))`;
    assert.match(
      await page.eval(`${card}.textContent.replace(/\\s+/g, ' ')`),
      /86\.5% translated 86\.2% approved/,
    );
    assert.equal(await page.eval(`${card}.querySelector('.tag.platform').textContent`), 'Crowdin');
    assert.equal(
      await page.eval(`${card}.querySelector('.tag.platform').dataset.platform`),
      'crowdin',
    );
    assert.equal(
      await page.eval(`${card}.querySelector('.btn.primary').href`),
      'https://crowdin.com/project/kestrel-notes/sq',
    );
    assert.equal(await page.count('.chip[data-instance]'), 3); // all + two with data
    await page.click('.chip[data-instance="crowdin"]');
    assert.equal(await page.count('.entry'), 1);
    await page.click('.chip[data-instance="all"]');
    // the token is kept in the browser and stays out of the config
    assert.match(await page.eval(`localStorage.getItem('tallyglot:tokens')`), /crowdin-secret/);
    assert.ok(
      !(await page.eval(`localStorage.getItem('tallyglot:settings')`)).includes('crowdin-secret'),
    );
  });

  await step('platforms: adding one in Settings, once', async () => {
    await page.click('#open-settings');
    await page.fill('#new-platform', 'transifex');
    await page.click('[data-action="add-platform"]');
    await page.waitFor(`document.querySelector('.inst[data-platform="transifex"]')`);
    assert.equal(await page.eval(`document.activeElement.name`), 'pinned');
    await page.fill('#new-platform', 'transifex');
    await page.click('[data-action="add-platform"]');
    assert.match(await page.text('#toast'), /Transifex is already in the list/);
    assert.equal(await page.count('.inst[data-platform="transifex"]'), 1);
    await page.click('[data-action="close-settings"]');
  });

  /* ---------- 2. stats ---------- */

  await step('stats: calendar, tiles, chart and milestones from the demo data', async () => {
    await open(
      '?demo&view=stats',
      `document.querySelector('.heatmap-svg') && document.querySelector('#card img')`,
    );
    assert.equal(
      await page.eval(`document.querySelectorAll('.heatmap-svg rect').length >= 365`),
      true,
    );
    assert.equal(
      await page.eval(
        `[...document.querySelectorAll('.heatmap-svg rect')].every((r) => /^var\\(--/.test(r.getAttribute('fill')))`,
      ),
      true,
    );
    const tiles = await texts('.stats-tiles .tile');
    assert.equal(tiles.length, 4);
    assert.match(tiles[0], /^[\d,]+ ?contributions$/);
    assert.match(tiles[1], /^\d+ days? ?current streak$/);
    assert.equal(await page.count('#chart svg path'), 1);
    assert.ok((await page.count('.timeline li')) >= 3);
    assert.match((await texts('.timeline li')).join(' '), /reached 100%/);
    assert.equal(await page.eval(`document.title`), 'Stats · Albanian · Tallyglot');
    assert.equal(
      await page.eval(`document.querySelector('[data-nav="stats"]').getAttribute('aria-current')`),
      'page',
    );
  });

  await step('stats: project and period change the chart; the table view matches', async () => {
    const before = await page.eval(`document.querySelector('#chart').dataset.coords`);
    await page.fill('#chart-project', 'hosted:quillpad');
    await page.waitFor(
      `document.querySelector('#chart').dataset.coords !== ${JSON.stringify(before)}`,
    );
    assert.equal(await page.eval(`document.activeElement.id`), 'chart-project');
    await page.fill('#chart-range', '30');
    await page.waitFor(`JSON.parse(document.querySelector('#chart').dataset.coords).length <= 31`);
    const points = await page.eval(
      `JSON.parse(document.querySelector('#chart').dataset.coords).length`,
    );
    assert.equal(await page.count('#chart-box tbody tr'), points);
    await page.fill('#chart-range', 'all');
    await page.fill('#chart-project', '');
  });

  await step('stats: the chart can be read with the keyboard', async () => {
    await page.eval(`document.querySelector('#chart').focus()`);
    await page.waitFor(`!document.querySelector('.chart-tip').hidden`);
    const last = await page.text('.chart-tip');
    await key('ArrowLeft');
    const previous = await page.text('.chart-tip');
    assert.notEqual(previous, last);
    await key('Home');
    assert.notEqual(await page.text('.chart-tip'), previous);
    await key('End');
    assert.equal(await page.text('.chart-tip'), last);
    assert.match(last, /^\d+(\.\d)?% .* of [\d,]+ strings$/);
    await page.eval(`document.activeElement.blur()`);
    assert.equal(await page.eval(`document.querySelector('.chart-tip').hidden`), true);
  });

  /* ---------- 3. profile card and achievements ---------- */

  await step('card: both variants, theme switch and <picture> snippet', async () => {
    assert.equal(await page.count('#card .card-pair img'), 2);
    const svg = decodeURIComponent(await page.eval(`document.querySelector('#card img').src`));
    assert.match(svg, /Albanian team · Albanian/);
    assert.match(svg, /TOP LANGUAGES/);
    assert.match(
      await page.eval(`document.querySelector('#card-snippet').value`),
      /cards\/dark\.svg">\s*<img src="[^"]+cards\/light\.svg"/,
    );
    await page.click('[data-family="ocean"]');
    assert.match(
      await page.eval(`document.querySelector('#card-snippet').value`),
      /ocean-dark\.svg[\s\S]*ocean-light\.svg/,
    );
    assert.equal(await page.eval(`document.activeElement.dataset.family`), 'ocean');
    assert.ok(
      decodeURIComponent(await page.eval(`document.querySelector('#card img').src`)).includes(
        '#f6fbfd',
      ),
    );
    assert.ok((await page.count('.medal.earned')) >= 3);
    assert.ok((await page.count('.medal:not(.earned)')) >= 1);
  });

  /* ---------- 5. find work ---------- */

  await step('find work: ranked by popularity, filtered, tracked projects hidden', async () => {
    await open('?demo&view=find', `document.querySelector('.find-table')`);
    const names = () => texts('.find-table tbody th a:first-child');
    assert.equal((await names()).length, 17);
    assert.deepEqual((await names()).slice(0, 3), [
      'Tidewater Sync',
      'Bramble Photos',
      'Juniper Forge',
    ]);
    await page.fill('#find-max', '0');
    assert.ok((await names()).every((n) => !['Bramble Photos', 'Kiln Markdown'].includes(n)));
    assert.equal((await names()).length, 8);
    await page.fill('#find-max', '100');
    const all = (await names()).length;
    await page.click('[data-hide-tracked]');
    assert.equal((await names()).length, all + 11);
    await page.click('[data-hide-tracked]');
    await page.fill('#find-query', 'wren');
    assert.deepEqual(await names(), ['Wren Launcher']);
    await page.fill('#find-query', 'zzzz');
    assert.match(await page.text('.none'), /No projects match/);
    await page.fill('#find-query', '');
    await page.fill('#find-sort', 'most');
    assert.equal((await names())[0], 'Bellows Docs');
    await page.click('[data-find-instance="codeberg"]');
    assert.ok((await texts('.find-table .tag')).every((x) => x === 'Codeberg Translate'));
    assert.equal(await page.count('[data-scan]'), 0); // demo never calls an API
  });

  await step('find work: reads more of a platform on request', async () => {
    await open('?view=find', `document.querySelector('[data-scan]')`);
    assert.match(await page.text('.welcome'), /Nothing has been read yet/);
    await page.click('[data-scan]');
    await page.waitFor(`/Read 2 more projects/.test(document.querySelector('#toast').textContent)`);
    await page.waitFor(`document.querySelector('.find-table')`);
    // Alpha is on the dashboard already, so only Delta is offered
    assert.deepEqual(await texts('.find-table tbody th a:first-child'), ['Delta']);
    assert.match(await page.text('.find-table tbody tr'), /Not started 800/);
    assert.match(await page.text('#find-sources'), /all 2 projects read/);
    assert.equal(await page.count('[data-scan]'), 0); // nothing left to read
    await open('?view=find', `document.querySelector('.find-table')`); // kept in this browser
    assert.deepEqual(await texts('.find-table tbody th a:first-child'), ['Delta']);
  });

  await step('find work: a platform that fails says so and leaves the page usable', async () => {
    await page.eval(`localStorage.removeItem('tallyglot:findwork')`);
    weblate.state.mode = 'limit';
    await open('?view=find', `document.querySelector('[data-scan]')`);
    await page.click('[data-scan]');
    await page.waitFor(
      `/Nothing new could be read/.test(document.querySelector('#toast').textContent)`,
    );
    assert.match(await page.text('#find-sources'), /last attempt: rate limit reached/);
    assert.equal(await page.eval(`document.querySelector('[data-scan]').disabled`), false);
    weblate.state.mode = 'ok';
  });

  /* ---------- 6. team ---------- */

  await step('team: leaderboard, closest projects and recent activity', async () => {
    await open('?demo&view=team', `document.querySelector('#team-board-body table')`);
    assert.match(await page.text('.page-head h1'), /^Albanian team$/);
    assert.equal(await page.count('.closest li'), 6);
    assert.equal(await page.count('#team-board-body tbody tr'), 3);
    const month = await texts('#team-board-body tbody th');
    await page.fill('#team-period', 'all');
    const allTime = await page.eval(
      `[...document.querySelectorAll('#team-board-body tbody tr')].map((r) => Number(r.children[2].textContent.replace(/\\D/g, '')))`,
    );
    assert.deepEqual(
      [...allTime].sort((a, b) => b - a),
      allTime,
    );
    assert.ok(allTime[0] > 1000);
    assert.equal(month.length, 3);
    assert.ok((await page.count('.timeline li')) >= 5);
    assert.equal(await page.count('#team-all + .table-wrap tbody tr'), 11);
    await page.eval(
      `(() => { window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; })()`,
    );
    await page.click('[data-share]');
    await page.waitFor(`window.__copied`);
    assert.match(await page.eval(`window.__copied`), /\?demo&view=team$/);
  });

  /* ---------- review queue and glossary ---------- */

  await step('review: counts per kind, filters, and links into the editor', async () => {
    await open('', `document.querySelectorAll('.entry').length === 4`);
    await settled();
    await page.click('[data-nav="review"]');
    await page.waitFor(`document.querySelector('.queue')`);
    assert.deepEqual(await texts('.stats-tiles .tile-value'), ['6', '0', '4', '1']);
    assert.equal(await page.count('.queue-item'), 5); // 3 with checks, 1 to edit, 1 comment
    assert.match(await page.text('.queue-item'), /Ui.*4 strings marked for editing/);
    await page.click('[data-kind="comments"]');
    assert.equal(await page.count('.queue-item'), 1);
    assert.equal(
      await page.eval(`document.querySelector('.queue-item a.btn').href`),
      `${weblate.url}/translate/alpha/docs/sq/?q=has%3Acomment`,
    );
    await page.click('[data-kind="suggestions"]');
    assert.match(await page.text('#queue .none'), /queue is empty/);
    await page.click('[data-kind="checks"]');
    assert.equal(await page.count('.queue-item'), 3);
  });

  await step(
    'review: the strings behind a count, each linked, and markup shown as text',
    async () => {
      const item = `document.querySelector('[data-item$=":alpha/ui#checks"]')`;
      const before = weblate.state.requests.length;
      await page.eval(`${item}.querySelector('[data-strings]').click()`);
      await page.waitFor(`${item}.querySelectorAll('.strings li').length === 2`);
      assert.equal(weblate.state.requests.length, before + 1);
      assert.deepEqual(weblate.state.requests.at(-1).query, { q: 'has:check', page_size: '20' });
      assert.equal(weblate.state.requests.at(-1).auth, null);
      assert.equal(
        await page.eval(`${item}.querySelector('.strings a').href`),
        `${weblate.url}/translate/alpha/ui/sq/?checksum=1`,
      );
      assert.equal(await page.eval(`${item}.querySelectorAll('.strings b').length`), 0);
      assert.match(
        await page.eval(`${item}.querySelector('.strings').textContent`),
        /Save <b>all<\/b>\s*\(not translated\)/,
      );
      assert.equal(await page.eval(`document.activeElement.getAttribute('aria-expanded')`), 'true');
      await page.eval(`${item}.querySelector('[data-strings]').click()`);
      assert.equal(await page.eval(`${item}.querySelectorAll('.strings li').length`), 0);
      // a rate limit is explained in place, and the editor link still works
      weblate.state.mode = 'limit';
      await page.eval(`${item}.querySelector('[data-strings]').click()`);
      await page.waitFor(`${item}.querySelector('.notice.warn')`);
      assert.match(
        await page.eval(`${item}.querySelector('.notice.warn').textContent`),
        /request limit is used up/,
      );
      weblate.state.mode = 'ok';
      assert.equal(await page.count('.queue-item a.btn.primary'), 3);
    },
  );

  await step('review: demo shows alerts and never calls an API', async () => {
    await open('?demo&view=review', `document.querySelector('.queue')`);
    assert.equal(await page.count('[data-strings]'), 0);
    assert.match(
      await page.text('.block-head + .timeline li'),
      /Quillpad added 310 strings 2,353 waiting/,
    );
    assert.match(await page.eval(`document.querySelector('.block-head a').href`), /\/feed\.xml$/);
  });

  await step('glossary: inconsistent terms, a preferred translation, and search', async () => {
    await open('?demo&view=glossary', `document.querySelector('.terms')`);
    assert.deepEqual(await texts('.stats-tiles .tile-value'), ['15', '7', '7', '79']);
    assert.equal(await page.count('.term'), 7);
    assert.equal(await page.text('.term h3'), 'Settings');
    assert.deepEqual(await texts('.term:first-child .variant-target'), [
      'Cilësimet',
      'Rregullimet',
      'Parametrat',
    ]);
    assert.match(
      await page.eval(`document.querySelector('.term .variant-links a').href`),
      /\/translate\/[\w-]+\/[\w-]+\/sq\/\?q=id:\d+$/,
    );
    await page.click('.term:first-child .variant:nth-child(2) input');
    await page.waitFor(`document.querySelector('.term:first-child .tag.ok')`);
    assert.equal(await page.eval(`document.activeElement.value`), 'Rregullimet');
    assert.deepEqual(await texts('.stats-tiles .tile-value'), ['15', '7', '6', '79']);
    await page.click('.term:first-child [data-clear]');
    assert.deepEqual(await texts('.stats-tiles .tile-value'), ['15', '7', '7', '79']);
    await page.click('[data-show="all"]');
    assert.equal(await page.count('.term'), 15);
    await page.fill('#glossary-query', 'ndihm');
    assert.deepEqual(await texts('.term h3'), ['Help']);
    await page.fill('#glossary-query', 'qqq');
    assert.match(await page.text('#glossary-list .none'), /No terms match/);
    await page.fill('#glossary-query', '');
  });

  await step('glossary: CSV and TBX exports carry the chosen terms', async () => {
    await page.eval(`(() => {
      window.__files = [];
      const make = URL.createObjectURL;
      URL.createObjectURL = (blob) => { blob.text().then((text) => window.__files.push({ type: blob.type, text })); return make(blob); };
      HTMLAnchorElement.prototype.click = function () { window.__name = this.download; };
    })()`);
    await page.click('[data-show="inconsistent"]');
    await page.click('.term:first-child .variant:nth-child(3) input'); // Parametrat
    await page.click('[data-export="csv"]');
    await page.waitFor(`window.__files.length === 1`);
    const csv = await page.eval(`window.__files[0].text`);
    assert.equal(await page.eval(`window.__name`), 'glossary-sq.csv');
    assert.match(csv, /^source,target\r\n/);
    assert.match(csv, /\r\nSettings,Parametrat\r\n/);
    assert.match(csv, /\r\nSave,Ruaj\r\n/); // undecided: the most used one
    assert.equal(csv.trim().split('\r\n').length, 16);
    await page.click('#glossary-strict');
    await page.click('[data-export="tbx"]');
    await page.waitFor(`window.__files.length === 2`);
    const tbx = await page.eval(`window.__files[1].text`);
    assert.equal(await page.eval(`window.__name`), 'glossary-sq.tbx');
    assert.equal(tbx.match(/<termEntry /g).length, 9); // 8 consistent + the one decided
    assert.ok(tbx.includes('<langSet xml:lang="sq"><tig><term>Parametrat</term></tig></langSet>'));
    assert.ok(!tbx.includes('Ruaj'));
    assert.equal(
      await page.eval(
        `new DOMParser().parseFromString(window.__files[1].text, 'application/xml').querySelector('parsererror')`,
      ),
      null,
    );
    assert.match(await page.text('#toast'), /Exported 9 terms/);
  });

  await step(
    'glossary: the records of the repository are not shown under other settings',
    async () => {
      await open('?view=glossary', `document.querySelector('.terms')`);
      assert.deepEqual(await texts('.term h3'), ['Save']); // recorded for the configured user
      // a visitor enters their own username in Settings: these records are not theirs
      await page.eval(
        `localStorage.setItem('tallyglot:settings', JSON.stringify({ language: 'sq', usernames: ['visitor'], instances: [{ url: ${JSON.stringify(weblate.url)} }] }))`,
      );
      await open('?view=glossary', `document.querySelector('.welcome')`);
      assert.match(await page.text('.welcome'), /No terms yet.*built once a day/);
      await open('?view=stats', `document.querySelector('.stats-tiles')`);
      assert.match(await page.text('#cal-title ~ p'), /No activity has been recorded yet/);
      await page.eval(
        `localStorage.removeItem('tallyglot:settings'); localStorage.removeItem('tallyglot:cache')`,
      );
    },
  );

  /* ---------- maintainer view ---------- */

  await step('maintainer: coverage of any project by address, with a shareable link', async () => {
    await open('?view=maintainer', `document.querySelector('#maintainer-form')`);
    assert.equal(await page.count('.tiles'), 0);
    await page.fill('[name="instance"]', weblate.url);
    await page.fill('[name="project"]', 'alpha');
    await page.eval(`document.querySelector('#maintainer-form').requestSubmit()`);
    await page.waitFor(`document.querySelector('.stats-tiles')`);
    assert.deepEqual(await texts('.stats-tiles .tile-value'), ['2', '74.5%', '1', '1']);
    assert.deepEqual(await texts('#m-langs + .table-wrap tbody th'), ['German de', 'Albanian sq']);
    assert.match(
      await page.text('#m-langs + .table-wrap tbody tr:nth-child(2)'),
      /49\.1% 610 .*Stale/,
    );
    assert.ok(!/Stale/.test(await page.text('#m-langs + .table-wrap tbody tr'))); // complete is never stale
    assert.deepEqual(await texts('#m-people + .table-wrap tbody th'), ['alice', 'bruno']); // the bot is left out
    const q = new URLSearchParams(await page.eval(`location.search`));
    assert.deepEqual(
      [q.get('view'), q.get('platform'), q.get('instance'), q.get('project')],
      ['maintainer', 'weblate', weblate.url, 'alpha'],
    );
    assert.match(
      decodeURIComponent(
        await page.eval(`document.querySelector('#m-readme ~ .card-pair img').src`),
      ),
      /Alpha: 2 languages, 74\.5% on average/,
    );
    assert.match(
      await page.eval(`document.querySelector('#m-readme ~ .field textarea').value`),
      /"maintainer"[\s\S]*"project": "alpha"/,
    );
    // the link works on its own, in a fresh page
    await open(await page.eval(`location.search`), `document.querySelector('.stats-tiles')`);
    assert.equal(await page.eval(`document.querySelector('[name="project"]').value`), 'alpha');
  });

  await step(
    'maintainer: unknown projects, limits, token platforms and Pontoon explain themselves',
    async () => {
      const problem = async (query, pattern) => {
        await open(`?view=maintainer&${query}`, `document.querySelector('.notice.warn')`);
        assert.match(await page.text('.notice.warn'), pattern, query);
        assert.equal(await page.count('#maintainer-form'), 1);
      };
      const here = encodeURIComponent(weblate.url);
      await problem(`platform=weblate&instance=${here}&project=nope`, /No such project/);
      weblate.state.mode = 'limit';
      await problem(`platform=weblate&instance=${here}&project=alpha`, /request limit is used up/);
      weblate.state.mode = 'ok';
      await problem(
        'platform=weblate&instance=http://127.0.0.1:9&project=x',
        /does not allow this page to read it/,
      );
      await problem('platform=pontoon&project=firefox', /cannot be read from a browser/);
      await problem('platform=transifex&project=a/b', /answers only with an API token/);
      assert.equal(await page.eval(`document.querySelector('[data-token]').hidden`), false);
      await page.fill('[name="platform"]', 'weblate');
      assert.equal(await page.eval(`document.querySelector('[data-token]').hidden`), true);
      assert.equal(
        await page.eval(`document.querySelector('[data-only="weblate"]').hidden`),
        false,
      );
      await open('?demo&view=maintainer&project=x', `document.querySelector('.notice.warn')`);
      assert.match(await page.text('.notice.warn'), /demo does not contact any platform/);
    },
  );

  await step('maintainer: Crowdin with the token saved in Settings', async () => {
    await open(
      `?view=maintainer&platform=crowdin&project=4242`,
      `document.querySelector('.stats-tiles')`,
    );
    assert.deepEqual(await texts('.stats-tiles .tile-value'), ['3', '68.6%', '1', '–']);
    assert.match(await page.text('#m-people ~ p'), /Crowdin does not publish who translated what/);
  });

  /* ---------- year in review ---------- */

  await step('wrapped: numbers for the year, other years, and the month chart', async () => {
    await open('?demo&view=wrapped', `document.querySelector('.wrap-grid')`);
    const year = new Date().getUTCFullYear();
    assert.equal(await page.text('.page-head h1'), `Your ${year} in translation`);
    await page.sleep(1100); // the count-up has finished
    const shown = await page.eval(
      `[...document.querySelectorAll('[data-count]')].map((el) => [el.dataset.count, el.textContent.replace(/\\D/g, '')])`,
    );
    assert.ok(shown.length >= 3);
    for (const [target, text] of shown) assert.equal(text, target);
    assert.equal(await page.count('.month-bars li'), 12);
    assert.ok((await page.count('.top-list li')) >= 3);
    assert.equal(
      await page.eval(`document.querySelector('.chips a[aria-current="page"]').textContent`),
      String(year),
    );
    await page.click(`.chips a.chip:not([aria-current])`);
    await page.waitFor(
      `document.querySelector('.page-head h1').textContent.includes('${year - 1}')`,
    );
    assert.equal(
      new URLSearchParams(await page.eval(`location.search`)).get('year'),
      String(year - 1),
    );
    await open('?demo&view=wrapped&year=1999', `document.querySelector('.wrap-grid')`); // unknown year: the latest
    assert.equal(await page.text('.page-head h1'), `Your ${year} in translation`);
  });

  await step('wrapped: share image in both sizes, downloaded as a real PNG', async () => {
    await page.eval(`(() => {
      window.__files = [];
      const make = URL.createObjectURL;
      URL.createObjectURL = (blob) => { blob.arrayBuffer().then((b) => window.__files.push({ type: blob.type, bytes: [...new Uint8Array(b).slice(0, 24)] })); return make(blob); };
      HTMLAnchorElement.prototype.click = function () { window.__name = this.download; };
    })()`);
    const year = new Date().getUTCFullYear();
    await page.click('[data-download="png"]');
    await page.waitFor(`window.__files.length === 1`);
    let file = await page.eval(`window.__files[0]`);
    assert.equal(file.type, 'image/png');
    assert.deepEqual(file.bytes.slice(0, 8), [137, 80, 78, 71, 13, 10, 26, 10]);
    // width and height are stored big-endian in the IHDR chunk
    assert.deepEqual(
      [file.bytes[18] * 256 + file.bytes[19], file.bytes[22] * 256 + file.bytes[23]],
      [1200, 630],
    );
    assert.equal(await page.eval(`window.__name`), `tallyglot-${year}-wide.png`);
    await page.click('[data-size="square"]');
    await page.click('[data-theme="dark"]');
    assert.equal(await page.eval(`document.activeElement.dataset.theme`), 'dark');
    assert.ok(
      decodeURIComponent(await page.eval(`document.querySelector('.share-preview').src`)).includes(
        '#131210',
      ),
    );
    await page.click('[data-download="png"]');
    await page.waitFor(`window.__files.length === 2`);
    file = await page.eval(`window.__files[1]`);
    assert.deepEqual(
      [file.bytes[18] * 256 + file.bytes[19], file.bytes[22] * 256 + file.bytes[23]],
      [1080, 1080],
    );
    await page.click('[data-download="svg"]');
    await page.waitFor(`window.__files.length === 3`);
    assert.equal(await page.eval(`window.__files[2].type`), 'image/svg+xml');
    assert.equal(await page.eval(`window.__name`), `tallyglot-${year}-square.svg`);
  });

  await step(
    'wrapped: reduced motion shows the numbers at once; no data is explained',
    async () => {
      await page.cmd('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      await open('?demo&view=wrapped', `document.querySelector('.wrap-grid')`);
      const shown = await page.eval(
        `[...document.querySelectorAll('[data-count]')].map((el) => [el.dataset.count, el.textContent.replace(/\\D/g, '')])`,
      );
      for (const [target, text] of shown) assert.equal(text, target);
      assert.equal(
        await page.eval(`document.querySelector('#page').classList.contains('animated')`),
        false,
      );
      await page.cmd('Emulation.setEmulatedMedia', { features: [] });
      await open('?view=wrapped', `document.querySelector('.welcome')`);
      assert.match(await page.text('.welcome'), /No year to look back on yet/);
    },
  );

  /* ---------- portfolio ---------- */

  await step(
    'portfolio: summary, projects with logo fallbacks, chart and achievements',
    async () => {
      await open('?demo&view=portfolio', `document.querySelector('.portfolio-projects')`);
      assert.equal(await page.text('.portfolio-head h1'), 'Albanian team');
      assert.deepEqual((await texts('.portfolio-stats dt')).slice(0, 3), [
        'strings translated',
        'projects',
        'fully translated',
      ]);
      assert.equal(await page.count('.portfolio-projects li'), 11);
      assert.equal(await page.text('.portfolio-projects .logo'), 'LR'); // no logo known: initials
      assert.equal(await page.count('#pf-history ~ .chart svg path'), 1);
      assert.ok((await page.count('.medal.earned')) >= 3);
      assert.equal(await page.count('.medal:not(.earned)'), 0);
      // a logo that fails to load gives way to the initials
      await page.eval(
        `(() => { const logo = document.querySelector('.logo'); logo.insertAdjacentHTML('afterbegin', '<img src="/no-such-logo.png" alt="">'); })()`,
      );
      await page.waitFor(`document.querySelectorAll('.logo img').length === 0`);
    },
  );

  await step(
    'portfolio: JSON Resume download, share link, and a print layout without chrome',
    async () => {
      await page.eval(`(() => {
      window.__files = [];
      const make = URL.createObjectURL;
      URL.createObjectURL = (blob) => { blob.text().then((text) => window.__files.push({ type: blob.type, text })); return make(blob); };
      HTMLAnchorElement.prototype.click = function () { window.__name = this.download; };
      window.print = () => { window.__printed = true; };
      navigator.clipboard.writeText = async (t) => { window.__copied = t; };
    })()`);
      await page.click('[data-portfolio="json"]');
      await page.waitFor(`window.__files.length === 1`);
      const resume = JSON.parse(await page.eval(`window.__files[0].text`));
      assert.equal(await page.eval(`window.__name`), 'resume-translation.json');
      assert.equal(resume.basics.name, 'Albanian team');
      assert.equal(resume.volunteer.length, 11);
      assert.match(resume.volunteer[0].position, /^Albanian translator$/);
      assert.match(resume.volunteer[0].startDate, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(resume.basics.url, /\?demo&view=portfolio$/);
      await page.click('[data-portfolio="link"]');
      await page.waitFor(`window.__copied`);
      await page.click('[data-portfolio="print"]');
      assert.equal(await page.eval(`window.__printed`), true);
      await page.cmd('Emulation.setEmulatedMedia', { media: 'print' });
      const visible = (sel) =>
        page.eval(
          `getComputedStyle(document.querySelector(${JSON.stringify(sel)})).display !== 'none'`,
        );
      for (const hidden of ['.top', '#nav', '#foot', '.no-print', '.notice'])
        assert.equal(await visible(hidden), false, hidden);
      for (const shown of ['.portfolio-head h1', '.portfolio-projects', '.medals'])
        assert.equal(await visible(shown), true, shown);
      const pdf = await page.cmd('Page.printToPDF', { printBackground: true });
      assert.equal(Buffer.from(pdf.data, 'base64').subarray(0, 5).toString(), '%PDF-');
      await page.cmd('Emulation.setEmulatedMedia', { media: '' });
    },
  );

  /* ---------- links from before this version ---------- */

  await step('old links keep working: ?demo, ?theme=, #settings, unknown ?view', async () => {
    await open('?demo&theme=dark', `document.querySelectorAll('.entry').length === 16`);
    assert.equal(await page.eval(`document.documentElement.dataset.theme`), 'dark');
    await open('?theme=light#settings', `document.querySelector('#settings').open`);
    assert.equal(await page.eval(`document.documentElement.dataset.theme`), 'light');
    await page.click('[data-action="close-settings"]');
    await open('?view=nonsense', `document.querySelectorAll('.entry').length === 4`);
    assert.equal(await page.eval(`document.body.dataset.view`), 'dashboard');
    assert.equal(await page.eval(`document.title`), 'Albanian · Tallyglot');
  });

  await step('a browser cache written by 1.0 is still understood', async () => {
    const fp = JSON.stringify([weblate.url, 'sq', ['alice'], []]);
    const old = {
      [weblate.url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/g, '-')]: {
        fingerprint: fp,
        updatedAt: new Date().toISOString(),
        source: 'live',
        errors: [],
        known: {
          users: { alice: new Date().toISOString() },
          translations: {},
          pins: {},
          missing: {},
        },
        entries: [
          {
            id: 'x:legacy/app',
            apiUrl: `${weblate.url}/api/translations/legacy/app/sq/`,
            instance: 'x',
            project: { slug: 'legacy', name: 'Legacy', url: `${weblate.url}/projects/legacy/` },
            component: { slug: 'app', name: 'Saved by 1.0' },
            language: { code: 'sq', name: 'Albanian' },
            total: 10,
            translated: 4,
            fuzzy: 1,
            untranslated: 5,
            translatedPercent: 40,
            review: false,
            approved: null,
            approvedPercent: null,
            failing: 0,
            suggestions: 0,
            lastChange: new Date().toISOString(),
            lastContribution: null,
            webUrl: `${weblate.url}/projects/legacy/app/sq/`,
            translateUrl: `${weblate.url}/translate/legacy/app/sq/`,
            pinned: false,
            fetchedAt: new Date().toISOString(),
          },
        ],
      },
    };
    await page.eval(
      `localStorage.setItem('tallyglot:cache', ${JSON.stringify(JSON.stringify(old))}); localStorage.removeItem('tallyglot:settings'); localStorage.setItem('tallyglot:prefs', '{"sort":"name","theme":"dark"}')`,
    );
    const before = weblate.state.requests.length;
    await open(
      '',
      `[...document.querySelectorAll('.entry h3')].some((h) => h.textContent.trim() === 'Saved by 1.0')`,
    );
    await page.sleep(300);
    assert.equal(weblate.state.requests.length, before, 'fresh cached data is not refetched');
    const card = `[...document.querySelectorAll('.entry')].find((c) => /Saved by 1.0/.test(c.textContent))`;
    assert.match(
      await page.eval(`${card}.textContent.replace(/\\s+/g, ' ')`),
      /40% translated 5 untranslated · 1 needs editing/,
    );
    assert.equal(
      await page.eval(`${card}.querySelector('.btn.primary').href`),
      `${weblate.url}/translate/legacy/app/sq/?q=state:empty`,
    );
    assert.equal(await page.eval(`document.querySelector('#sort').value`), 'name');
    assert.equal(await page.eval(`document.documentElement.dataset.theme`), 'dark');
    await page.eval(
      `localStorage.removeItem('tallyglot:cache'); localStorage.removeItem('tallyglot:prefs')`,
    );
  });

  /* ---------- 7. app quality ---------- */

  await step('i18n: a partial translation is used, with English for the rest', async () => {
    await open('?demo&lang=xx', `document.querySelectorAll('.entry').length === 16`);
    assert.deepEqual((await texts('#nav a')).slice(0, 3), ['Dashbord', 'Statistikz', 'Review']);
    assert.match(
      await page.text('.hero-caption'),
      /translated across 11 projektz and 16 components/,
    );
    assert.equal(await page.eval(`document.documentElement.lang`), 'xx');
    await page.click('#open-settings');
    assert.deepEqual(await texts('[name="locale"] option'), ['English', 'Test language']);
    await page.click('[data-action="close-settings"]');
  });

  await step('i18n: the interface language is chosen in Settings and remembered', async () => {
    await open('', `document.querySelectorAll('.entry').length === 4`);
    assert.equal((await texts('#nav a'))[1], 'Stats');
    await page.click('#open-settings');
    await page.fill('[name="locale"]', 'xx');
    await page.eval(`document.querySelector('#settings-form').requestSubmit()`);
    await page.waitFor(
      `document.querySelector('#nav a:nth-child(2)').textContent === 'Statistikz'`,
    );
    await open('', `document.querySelectorAll('.entry').length === 4`);
    assert.equal((await texts('#nav a'))[1], 'Statistikz');
    await page.click('#open-settings');
    await page.fill('[name="locale"]', 'en');
    await page.eval(`document.querySelector('#settings-form').requestSubmit()`);
    await page.waitFor(`document.querySelector('#nav a:nth-child(2)').textContent === 'Stats'`);
  });

  await step('pwa: manifest and icons are served', async () => {
    const manifest = await page.eval(
      `fetch(document.querySelector('link[rel="manifest"]').href).then((r) => r.json())`,
    );
    assert.equal(manifest.display, 'standalone');
    for (const icon of manifest.icons) {
      assert.equal(
        await page.eval(`fetch(${JSON.stringify(icon.src)}).then((r) => r.status)`),
        200,
        icon.src,
      );
    }
    assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
    assert.ok(manifest.icons.some((i) => i.sizes === '512x512' && i.type === 'image/png'));
  });

  await step('pwa: works offline from the cache, pages included', async () => {
    await open('?demo&view=stats', `document.querySelector('.heatmap-svg')`);
    await page.waitFor(`navigator.serviceWorker.controller`, 15000);
    await open('?demo&view=team', `document.querySelector('#team-board-body table')`);
    await open('?demo', `document.querySelectorAll('.entry').length === 16`);
    const { port } = app;
    app.close();
    await page.cmd('Network.enable');
    await page.cmd('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await open('?demo', `document.querySelectorAll('.entry').length === 16`);
    assert.equal(await page.eval(`document.querySelector('#offline').hidden`), false);
    assert.match(await page.text('#offline'), /You are offline/);
    await page.click('[data-nav="stats"]');
    await page.waitFor(`document.querySelector('.heatmap-svg')`);
    await page.click('[data-nav="team"]');
    await page.waitFor(`document.querySelector('#team-board-body table')`);
    await page.cmd('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    app = await startApp(overrides, port);
    await page.waitFor(`document.querySelector('#offline').hidden`);
    await page.eval(`window.__errors.splice(0)`); // failed fetches while offline are expected
  });

  await step('a11y: skip link, landmarks, names for every control and image', async () => {
    await open('?demo', `document.querySelectorAll('.entry').length === 16`);
    await key('Tab');
    assert.equal(await page.eval(`document.activeElement.id`), 'skip');
    assert.equal(await page.eval(`getComputedStyle(document.activeElement).top`), '8px');
    await key('Enter');
    assert.equal(await page.eval(`location.hash`), '#app');
    for (const query of [
      '?demo',
      '?demo&view=stats',
      '?demo&view=find',
      '?demo&view=team',
      '?demo&view=review',
      '?demo&view=glossary',
      '?demo&view=wrapped',
      '?demo&view=portfolio',
      '?view=maintainer',
      '?view=setup',
    ]) {
      await open(query, `document.querySelector('#app h1')`);
      await page.sleep(200);
      const unnamed =
        await page.eval(`[...document.querySelectorAll('button, a[href], input, select, textarea')]
        .filter((el) => el.offsetParent !== null)
        .filter((el) => !(el.getAttribute('aria-label') || el.textContent.trim() || el.title || el.labels?.length || el.closest('label')))
        .map((el) => el.outerHTML.slice(0, 120))`);
      assert.deepEqual(unnamed, [], `controls without a name on ${query}`);
      assert.deepEqual(
        await page.eval(
          `[...document.querySelectorAll('img:not([alt]), svg[role="img"]:not([aria-label])')].map((el) => el.outerHTML.slice(0, 100))`,
        ),
        [],
        query,
      );
      assert.equal(await page.count('h1'), 1, `one h1 on ${query}`);
      assert.equal(await page.count('main'), 1);
    }
  });

  await step('a11y: pages move focus to the content and announce themselves by title', async () => {
    await open('?demo', `document.querySelectorAll('.entry').length === 16`);
    await page.eval(`document.querySelector('[data-nav="team"]').focus()`);
    await key('Enter');
    await page.waitFor(`document.querySelector('#team-board-body table')`);
    assert.equal(await page.eval(`document.activeElement.id`), 'app');
    assert.match(await page.eval(`document.title`), /^Team · /);
    await page.eval(`history.back()`);
    await page.waitFor(`document.querySelectorAll('.entry').length === 16`);
    assert.equal(await page.eval(`location.search`), '?demo');
  });

  await step('a11y: reduced motion turns animation off', async () => {
    await page.cmd('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    assert.equal(
      await page.eval(`getComputedStyle(document.querySelector('.btn')).transitionDuration`),
      '0s',
    );
    assert.equal(
      await page.eval(`getComputedStyle(document.querySelector('.bar > span')).transitionDuration`),
      '0s',
    );
    await page.cmd('Emulation.setEmulatedMedia', { features: [] });
  });

  /* ---------- 8. guided setup ---------- */

  await step('setup: starts empty, explains what is missing, builds valid JSON', async () => {
    await open('?view=setup', `document.querySelector('#setup-json')`);
    assert.equal(await page.eval(`document.querySelector('[name="language"]').value`), '');
    assert.match(
      (await texts('.problem-list li')).join(' '),
      /Enter a language code.*Enter your Weblate username/,
    );
    assert.equal(await page.eval(`document.querySelector('[data-setup="try"]').disabled`), true);
    await page.fill('[name="language"]', 'pt BR!');
    assert.match((await texts('.problem-list li')).join(' '), /looks unusual/);
    await page.fill('[name="language"]', 'pt_BR');
    await page.fill('[name="usernames"]', ' ana , ana_b ');
    await page.click('[name="weblate:fedora"]');
    await page.click('[name="on:transifex"]');
    assert.equal(
      await page.eval(`document.querySelector('[data-fields="transifex"]').hidden`),
      false,
    );
    assert.match(
      (await texts('.problem-list li')).join(' '),
      /List at least one Transifex project/,
    );
    await page.fill('[name="projects:transifex"]', 'heron');
    assert.match((await texts('.problem-list li')).join(' '), /organization\/project/);
    await page.fill('[name="projects:transifex"]', 'heron/heron-desktop');
    await page.click('[name="webhook"]');
    await page.click('[name="digest"]');
    await page.fill('[name="team"]', 'Equipe');
    assert.equal(await page.count('.problem-list'), 0);
    const config = JSON.parse(await page.eval(`document.querySelector('#setup-json').value`));
    assert.deepEqual(config, {
      language: 'pt_BR',
      usernames: ['ana', 'ana_b'],
      instances: [
        { id: 'hosted' },
        { id: 'fedora' },
        { platform: 'transifex', projects: ['heron/heron-desktop'] },
      ],
      team: { name: 'Equipe' },
      alerts: { channels: ['rss', 'webhook'], digest: false },
    });
  });

  await step('setup: custom instances, bad addresses, and links for the walkthrough', async () => {
    await page.fill('#setup-url', 'nonsense');
    await page.click('[data-setup="add-url"]');
    assert.match(await page.text('#toast'), /address/);
    await page.fill('#setup-url', 'weblate.example.org/api/');
    await page.click('[data-setup="add-url"]');
    assert.deepEqual(await texts('.custom-list code'), ['https://weblate.example.org']);
    await page.fill('#setup-url', 'https://translate.codeberg.org');
    await page.click('[data-setup="add-url"]');
    assert.equal(
      await page.eval(`document.querySelector('[name="weblate:codeberg"]').checked`),
      true,
    );
    assert.equal(await page.count('.custom-list li'), 1);
    assert.match(await page.text('.steps'), /Enter your GitHub username above/);
    await page.fill('[name="github"]', '@Ana-Dev');
    const links = await page.eval(`[...document.querySelectorAll('.steps a')].map((a) => a.href)`);
    assert.deepEqual(links, [
      'https://github.com/aubergine-ux/tallyglot/fork',
      'https://github.com/Ana-Dev/tallyglot/edit/main/tallyglot.config.json',
      'https://github.com/Ana-Dev/tallyglot/settings/secrets/actions',
      'https://github.com/Ana-Dev/tallyglot/settings/pages',
      'https://github.com/Ana-Dev/tallyglot/actions/workflows/badges.yml',
      'https://ana-dev.github.io/tallyglot/',
    ]);
    assert.match(await page.text('.steps'), /TALLYGLOT_TOKENS.*ALERT_WEBHOOK_URL/);
    await page.click('[data-done="fork"]');
    await open('?view=setup', `document.querySelector('#setup-json')`); // the draft survives a reload
    assert.equal(await page.eval(`document.querySelector('[name="language"]').value`), 'pt_BR');
    assert.equal(await page.eval(`document.querySelector('[data-done="fork"]').checked`), true);
    await page.click('[data-remove="0"]');
    assert.equal(await page.count('.custom-list li'), 0);
  });

  await step('setup: copy, start over, start from this dashboard, try it here', async () => {
    await page.eval(
      `(() => { window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; })()`,
    );
    await page.click('[data-setup="copy"]');
    await page.waitFor(`window.__copied`);
    assert.equal(JSON.parse(await page.eval(`window.__copied`)).language, 'pt_BR');
    await page.click('[data-setup="reset"]');
    await page.waitFor(`document.querySelector('[name="language"]').value === ''`);
    await page.click('[data-setup="prefill"]');
    await page.waitFor(`document.querySelector('[name="language"]').value === 'sq'`);
    assert.equal(await page.eval(`document.querySelector('[name="on:crowdin"]').checked`), true);
    assert.equal(
      await page.eval(`document.querySelector('[name="projects:crowdin"]').value`),
      '4242',
    );
    await page.click('[data-setup="reset"]');
    await page.waitFor(`document.querySelector('[name="language"]').value === ''`);
    await page.fill('[name="language"]', 'sq');
    await page.fill('[name="usernames"]', 'ghost');
    await page.click('[name="weblate:hosted"]'); // off: only the custom instance
    await page.fill('#setup-url', 'http://weblate.invalid');
    await page.click('[data-setup="add-url"]');
    await page.click('[data-setup="try"]');
    await page.waitFor(
      `!new URLSearchParams(location.search).has('view') && document.querySelector('.hero, .welcome')`,
    );
    const saved = JSON.parse(await page.eval(`localStorage.getItem('tallyglot:settings')`));
    assert.deepEqual(saved, {
      language: 'sq',
      usernames: ['ghost'],
      instances: [{ url: 'http://weblate.invalid' }],
    });
    await page.eval(
      `localStorage.removeItem('tallyglot:settings'); localStorage.removeItem('tallyglot:setup')`,
    );
  });

  /* ---------- every page, phone width ---------- */

  await step('no page overflows sideways at phone width', async () => {
    await page.cmd('Emulation.setDeviceMetricsOverride', {
      width: 360,
      height: 780,
      deviceScaleFactor: 1,
      mobile: true,
    });
    for (const view of [
      'stats',
      'find',
      'team',
      'setup',
      'review',
      'glossary',
      'wrapped',
      'maintainer',
      'portfolio',
    ]) {
      await open(`?demo&view=${view}`, `document.querySelector('#page h1')`);
      await page.sleep(400);
      assert.equal(
        await page.eval(`document.documentElement.scrollWidth <= window.innerWidth`),
        true,
        view,
      );
    }
    await page.cmd('Emulation.clearDeviceMetricsOverride');
  });

  await step('nothing threw along the way', async () => {
    assert.deepEqual(errors, []);
  });
} finally {
  await page.close();
  app.close();
  weblate.close();
  crowdin.close();
}

console.log(failed ? '\nPage tests FAILED' : '\nPage tests passed');
process.exit(failed ? 1 : 0);
