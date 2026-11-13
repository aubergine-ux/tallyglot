import assert from 'node:assert/strict';
import { test } from 'node:test';

import { achievements, earnedMarks } from '../src/achievements.js';
import {
  CARD_FAMILIES,
  CARD_THEMES,
  cardData,
  cardFiles,
  cardSnippet,
  renderCard,
} from '../src/card.js';

const entry = (platform, project, total, translated, code = 'sq', name = 'Albanian') => ({
  instance: platform,
  platform,
  project: { slug: project, name: project },
  language: { code, name },
  total,
  translated,
  fuzzy: 0,
  untranslated: total - translated,
});
const days = (n, perDay, end = '2026-11-12') => {
  const out = {};
  for (let i = 0; i < n; i += 1) {
    out[new Date(Date.parse(end) - i * 86400000).toISOString().slice(0, 10)] = { p: perDay };
  }
  return { days: out };
};

test('achievements: earned, in progress, and one per platform in use', () => {
  const list = achievements({
    entries: [
      entry('weblate', 'a', 10, 10),
      entry('weblate', 'b', 10, 5),
      entry('pontoon', 'c', 10, 9),
    ],
    activity: days(8, 150),
    today: '2026-11-12',
  });
  const by = Object.fromEntries(list.map((a) => [a.id, a]));
  assert.deepEqual(Object.keys(by), [
    'changes-1k',
    'changes-10k',
    'complete-1',
    'complete-10',
    'streak-7',
    'streak-30',
    'streak-100',
    'platform-weblate',
    'platform-pontoon',
  ]);
  assert.equal(by['changes-1k'].earned, true);
  assert.deepEqual([by['changes-10k'].earned, by['changes-10k'].value], [false, 1200]);
  assert.equal(by['complete-1'].earned, true);
  assert.deepEqual([by['complete-10'].value, by['complete-10'].goal], [1, 10]);
  assert.equal(by['streak-7'].earned, true);
  assert.equal(by['streak-30'].value, 8);
  assert.equal(by['platform-weblate'].earned, true);
  assert.equal(by['platform-pontoon'].earned, false);
  // the card shows the best of each kind, never a wall of medals
  assert.deepEqual(
    earnedMarks(list).map((a) => a.mark),
    ['1K', '100', '7d', 'W'],
  );
});

test('achievements: nothing earned with no data, and nothing crashes', () => {
  const list = achievements({ entries: [], activity: null, today: '2026-11-12' });
  assert.equal(list.length, 7);
  assert.ok(list.every((a) => !a.earned && a.value === 0));
  assert.deepEqual(earnedMarks(list), []);
});

test('card: data, every theme, and escaping', () => {
  const data = cardData({
    entries: [
      entry('weblate', 'a', 1000, 900),
      entry('weblate', 'b', 500, 500),
      entry('crowdin', 'c', 200, 50, 'pt-BR', ''),
    ],
    activity: days(3, 10),
    title: 'A <b>& "C"',
    languageNames: { 'pt-BR': 'Portuguese (Brazil)' },
    today: '2026-11-12',
  });
  assert.equal(data.translated, 1450);
  assert.equal(data.projects, 3);
  assert.equal(data.completeProjects, 1);
  assert.equal(data.contributions, 30);
  assert.equal(data.streak, 3);
  assert.deepEqual(data.languages, [
    { name: 'Albanian', translated: 1400, percent: 93.3 },
    { name: 'Portuguese (Brazil)', translated: 50, percent: 25 },
  ]);
  for (const theme of Object.keys(CARD_THEMES)) {
    const svg = renderCard(data, theme);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="480"/);
    assert.ok(svg.includes(CARD_THEMES[theme].bg));
    assert.ok(svg.includes('A &#60;b&#62;&#38; &#34;C&#34;'));
    assert.ok(!/NaN|undefined/.test(svg));
    assert.ok(svg.includes('>1,450<'));
    assert.ok(svg.includes('3 days'));
  }
  assert.equal(renderCard(data, 'nope'), renderCard(data, 'light'));
});

test('card: empty data still renders', () => {
  const data = cardData({ entries: [], activity: null, title: 'x', today: '2026-11-12' });
  const svg = renderCard(data);
  assert.ok(!/NaN|undefined/.test(svg));
  assert.ok(svg.includes('0 days'));
  assert.ok(!svg.includes('TOP LANGUAGES'));
});

test('card: every family has both variants and a <picture> snippet', () => {
  for (const family of CARD_FAMILIES) {
    const files = cardFiles(family);
    assert.ok(CARD_THEMES[files.light.replace('.svg', '')], files.light);
    assert.ok(CARD_THEMES[files.dark.replace('.svg', '')], files.dark);
  }
  assert.equal(Object.keys(CARD_THEMES).length, CARD_FAMILIES.length * 2);
  const html = cardSnippet('https://x.test/t/', 'ocean', 'My "stats"');
  assert.match(
    html,
    /<source media="\(prefers-color-scheme: dark\)" srcset="https:\/\/x\.test\/t\/cards\/ocean-dark\.svg">/,
  );
  assert.match(
    html,
    /<img src="https:\/\/x\.test\/t\/cards\/ocean-light\.svg" alt="My &quot;stats&quot;">/,
  );
});
