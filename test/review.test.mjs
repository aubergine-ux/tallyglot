import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WeblateClient } from '../src/api.js';
import {
  REVIEW_KINDS,
  canListStrings,
  loadStrings,
  reviewItems,
  reviewTotals,
  reviewUrl,
} from '../src/review.js';
import { fakeFetch, fixture } from './helpers.mjs';

const entry = (id, counts = {}, extra = {}) => ({
  id,
  apiUrl: `https://w.test/api/translations/${id.split(':')[1]}/sq/`,
  instance: id.split(':')[0],
  platform: 'weblate',
  project: { name: id.split(':')[1].split('/')[0] },
  component: { name: 'c' },
  translateUrl: `https://w.test/translate/${id.split(':')[1]}/sq/`,
  webUrl: `https://w.test/projects/${id.split(':')[1]}/sq/`,
  failing: 0,
  suggestions: 0,
  fuzzy: 0,
  ...counts,
  ...extra,
});

test('review: one item per component and kind, biggest first', () => {
  const entries = [
    entry('h:a/x', { failing: 3, fuzzy: 1 }),
    entry('h:b/x', { suggestions: 12, comments: 2 }),
    entry('h:c/x'), // nothing waiting
    entry('h:d/x', { failing: 3 }),
  ];
  const items = reviewItems(entries);
  assert.deepEqual(
    items.map((i) => [i.id, i.count]),
    [
      ['h:b/x#suggestions', 12],
      ['h:a/x#checks', 3],
      ['h:d/x#checks', 3],
      ['h:b/x#comments', 2],
      ['h:a/x#editing', 1],
    ],
  );
  assert.deepEqual(
    reviewItems(entries, ['checks']).map((i) => i.id),
    ['h:a/x#checks', 'h:d/x#checks'],
  );
  assert.deepEqual(reviewTotals(entries), { checks: 6, suggestions: 12, editing: 1, comments: 2 });
  assert.deepEqual(reviewItems([]), []);
  assert.deepEqual(reviewTotals([]), { checks: 0, suggestions: 0, editing: 0, comments: 0 });
});

test('review: entries saved by 1.0 have no comment count and do not break', () => {
  const old = entry('h:a/x', { failing: 1 });
  delete old.platform;
  delete old.comments;
  assert.deepEqual(
    reviewItems([old]).map((i) => i.kind),
    ['checks'],
  );
  assert.equal(canListStrings(old), true);
});

test('review: links filter the editor on each platform', () => {
  const w = entry('h:a/x');
  assert.deepEqual(
    REVIEW_KINDS.map((k) => reviewUrl(w, k)),
    [
      'https://w.test/translate/a/x/sq/?q=has%3Acheck',
      'https://w.test/translate/a/x/sq/?q=has%3Asuggestion',
      'https://w.test/translate/a/x/sq/?q=state%3Aneeds-editing',
      'https://w.test/translate/a/x/sq/?q=has%3Acomment',
    ],
  );
  const p = {
    platform: 'pontoon',
    translateUrl: 'https://p.test/sq/amo/all-resources/',
    webUrl: 'https://p.test/sq/amo/',
  };
  assert.equal(
    reviewUrl(p, 'checks'),
    'https://p.test/sq/amo/all-resources/?status=errors,warnings',
  );
  assert.equal(
    reviewUrl(p, 'suggestions'),
    'https://p.test/sq/amo/all-resources/?status=unreviewed',
  );
  assert.equal(reviewUrl(p, 'comments'), 'https://p.test/sq/amo/all-resources/');
  assert.equal(canListStrings(p), false);
  const c = { platform: 'crowdin', translateUrl: '', webUrl: 'https://crowdin.com/project/x/sq' };
  assert.equal(reviewUrl(c, 'checks'), 'https://crowdin.com/project/x/sq');
  assert.equal(reviewUrl({ platform: 'lokalise' }, 'checks'), '');
});

test('review data source: strings come from the recorded units response', async () => {
  const log = [];
  const client = new WeblateClient({
    baseUrl: 'https://hosted.weblate.org',
    token: 'wlu_x',
    fetch: fakeFetch([['/units/', fixture('weblate-units')]], log),
  });
  const [item] = reviewItems([
    entry(
      'hosted:trale/localizations',
      { failing: 4 },
      { apiUrl: 'https://hosted.weblate.org/api/translations/trale/localizations/sq/' },
    ),
  ]);
  const { strings, more } = await loadStrings(client, item, { limit: 2 });
  assert.equal(log.length, 1);
  assert.match(
    log[0].url,
    /\/api\/translations\/trale\/localizations\/sq\/units\/\?q=has:check&page_size=2$/,
  );
  assert.equal(log[0].headers.Authorization, 'Token wlu_x');
  assert.deepEqual(strings[0], {
    source: 'Achievements',
    target: 'Arritjet',
    context: 'achievements',
    url: 'https://hosted.weblate.org/translate/trale/localizations/sq/?checksum=37396b5e073eddf2',
  });
  assert.equal(strings.length, 2);
  assert.equal(more, 261); // the response says 263 in total
});

test('review data source: empty lists, odd shapes and failures', async () => {
  const item = reviewItems([entry('h:a/x', { comments: 1 })])[0];
  const client = (routes) =>
    new WeblateClient({ baseUrl: 'https://w.test', fetch: fakeFetch(routes) });
  assert.deepEqual(await loadStrings(client([['/units/', { count: 0, results: [] }]]), item), {
    strings: [],
    more: 0,
  });
  const odd = await loadStrings(
    client([['/units/', { results: [{ source: 'plain', target: [], web_url: '' }] }]]),
    item,
  );
  assert.deepEqual(odd.strings, [{ source: 'plain', target: '', context: '', url: item.url }]);
  await assert.rejects(loadStrings(client([[/./, 429]]), item), { name: 'RateLimitError' });
  await assert.rejects(loadStrings(client([[/./, 403]]), item), /requires authentication/);
});
