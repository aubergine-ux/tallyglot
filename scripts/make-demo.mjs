#!/usr/bin/env node
// Regenerates the sample data behind ?demo (demo/config.json, demo/snapshot.json).
// The projects are made up; nothing here is fetched from a real instance.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { linesJson } from '../src/json.js';
import { stringifyHistory } from '../src/stats.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const now = new Date('2026-01-15T09:00:00Z').getTime();
const day = 86400000;
const instances = {
  hosted: { name: 'Hosted Weblate', url: 'https://hosted.weblate.org' },
  codeberg: { name: 'Codeberg Translate', url: 'https://translate.codeberg.org' },
  fedora: { name: 'Fedora Weblate', url: 'https://translate.fedoraproject.org' },
};

// instance, project, component, total, translated, fuzzy, approved (null = no review),
// failing checks, days since last activity, days since own contribution, pinned
const rows = [
  ['hosted', 'Lanternfish Reader', 'Android app', 1240, 1240, 0, 1198, 3, 2, 2, true],
  ['hosted', 'Lanternfish Reader', 'Store listing', 46, 46, 0, 46, 0, 64, 64, false],
  ['hosted', 'Quillpad', 'Web client', 2310, 2187, 21, null, 12, 1, 5, true],
  ['hosted', 'Quillpad', 'Documentation', 5120, 2890, 140, null, 31, 9, 9, false],
  ['hosted', 'Papaya Maps', 'Application', 3604, 3571, 4, 2950, 6, 4, 11, false],
  ['hosted', 'Papaya Maps', 'Glossary', 88, 88, 0, 88, 0, 120, 120, false],
  ['hosted', 'Tinderbox CI', 'Dashboard', 912, 501, 37, null, 9, 47, 47, false],
  ['hosted', 'Marrow Notes', 'Desktop', 1675, 1642, 0, null, 2, 0, 0, false],
  ['codeberg', 'Driftwood', 'Core', 780, 780, 0, null, 0, 15, 15, false],
  ['codeberg', 'Driftwood', 'Plugins', 432, 398, 6, null, 1, 38, 52, false],
  ['codeberg', 'Saltmarsh Mail', 'Client', 1490, 1012, 55, null, 14, 6, 6, true],
  ['codeberg', 'Pebble Feeds', 'Application', 356, 349, 0, null, 0, 3, 21, false],
  ['fedora', 'Harbor Installer', 'Main', 2044, 1809, 62, 1320, 18, 12, 30, false],
  ['fedora', 'Harbor Installer', 'Release notes', 640, 212, 9, 150, 2, 71, 96, false],
  ['fedora', 'Copperplate', 'UI', 518, 518, 0, 518, 0, 8, 8, false],
  ['fedora', 'Wicker Settings', 'Control panel', 1322, 1290, 3, 1004, 5, 2, 2, false],
];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const iso = (daysAgo) => new Date(now - daysAgo * day).toISOString();
const snapshot = {
  version: 1,
  generatedAt: new Date(now).toISOString(),
  language: { code: 'sq', name: 'Albanian' },
  instances: {},
};
for (const [id, inst] of Object.entries(instances)) {
  snapshot.instances[id] = { ...inst, updatedAt: snapshot.generatedAt, entries: [], errors: [] };
}
for (const [
  inst,
  project,
  component,
  total,
  translated,
  fuzzy,
  approved,
  failing,
  active,
  own,
  pinned,
] of rows) {
  const base = instances[inst].url;
  const path = `${slug(project)}/${slug(component)}`;
  snapshot.instances[inst].entries.push({
    id: `${inst}:${path}`,
    apiUrl: `${base}/api/translations/${path}/sq/`,
    instance: inst,
    project: { slug: slug(project), name: project, url: `${base}/projects/${slug(project)}/` },
    component: { slug: slug(component), name: component },
    language: { code: 'sq', name: 'Albanian' },
    total,
    translated,
    fuzzy,
    untranslated: total - translated - fuzzy,
    translatedPercent: Math.floor((translated / total) * 1000) / 10,
    review: approved !== null,
    approved,
    approvedPercent: approved === null ? null : Math.floor((approved / total) * 1000) / 10,
    failing,
    suggestions: failing > 8 ? Math.round(failing / 4) : 0,
    comments: failing % 3 === 0 && failing ? 1 + (failing % 4) : 0,
    lastChange: iso(active),
    lastContribution: iso(own),
    webUrl: `${base}/projects/${path}/sq/`,
    translateUrl: `${base}/translate/${path}/sq/`,
    pinned,
    fetchedAt: snapshot.generatedAt,
  });
}

// ---- activity and history: a believable year, generated from a fixed seed ----

let seed = 20260115;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const dayOf = (daysAgo) => iso(daysAgo).slice(0, 10);
const groups = new Map(); // "instance:project" -> { total, translated, weight }
for (const [inst, project, , total, translated] of rows) {
  const key = `${inst}:${slug(project)}`;
  const g = groups.get(key) || { total: 0, translated: 0 };
  g.total += total;
  g.translated += translated;
  groups.set(key, g);
}
const keys = [...groups.keys()];

const activity = {
  version: 1,
  updatedAt: snapshot.generatedAt,
  sources: {},
  days: {},
  users: {},
  recent: [],
};
const members = ['demo', 'mira', 'besnik'];
let mood = 0.5;
for (let ago = 400; ago >= 0; ago -= 1) {
  // Activity comes in spells: busy weeks, then a quiet stretch.
  mood = Math.min(0.95, Math.max(0.08, mood + (random() - 0.5) * 0.25));
  const holiday = ago > 150 && ago < 172;
  if (random() > mood || holiday) continue;
  const date = dayOf(ago);
  const picks = 1 + Math.floor(random() * 3);
  for (let i = 0; i < picks; i += 1) {
    const key = keys[Math.floor(random() ** 1.6 * keys.length)];
    const n = 1 + Math.floor(random() ** 2 * 40);
    const user = members[Math.floor(random() ** 2 * members.length)];
    (activity.days[date] ||= {})[key] = (activity.days[date][key] || 0) + n;
    const inst = key.split(':')[0];
    const byUser = ((activity.users[inst] ||= {})[user] ||= {});
    byUser[date] = (byUser[date] || 0) + n;
    if (ago < 12) {
      activity.recent.push({
        at: new Date(now - ago * day - Math.floor(random() * 8) * 3600000).toISOString(),
        user,
        project: key,
        component: 'app',
        action: random() > 0.3 ? 'Translation added' : 'Translation changed',
      });
    }
  }
}
activity.recent.sort((a, b) => b.at.localeCompare(a.at));

// Each project climbs to today's numbers; finished ones got there on a set day.
const finishedOn = {
  'hosted:lanternfish-reader': 9,
  'fedora:copperplate': 12,
};
const history = { version: 1, days: {} };
for (let ago = 240; ago >= 0; ago -= 1) {
  const point = { o: [0, 0, 0, rows.length, 0], p: {} };
  for (const [key, g] of groups) {
    const done = finishedOn[key];
    const start = g.translated * (0.35 + (key.length % 5) * 0.08);
    let translated;
    if (done !== undefined) {
      translated =
        ago <= done
          ? g.total
          : Math.round(start + (g.total - 8 - start) * (1 - (ago - done) / (240 - done)));
    } else {
      translated = Math.round(start + (g.translated - start) * (1 - ago / 240) ** 0.8);
    }
    // New source strings land now and then, which is what alerts report.
    const total = ago > 20 && key === 'hosted:quillpad' ? g.total - 310 : g.total;
    point.p[key] = [total, Math.min(total, translated)];
    point.o[0] += total;
    point.o[1] += Math.min(total, translated);
  }
  history.days[dayOf(ago)] = point;
}

// ---- find work: made-up projects that need Albanian ----

const candidates = [
  ['hosted', 'Tidewater Sync', 4120, 0, 48200, 61],
  ['hosted', 'Bramble Photos', 2980, 310, 31900, 54],
  ['hosted', 'Orchard Budget', 1640, 0, 12400, 38],
  ['hosted', 'Kiln Markdown', 860, 520, 9800, 44],
  ['hosted', 'Heronry Chat', 5210, 1190, 7600, 47],
  ['hosted', 'Gullwing Player', 1320, 0, 5300, 29],
  ['hosted', 'Mossbank Wiki', 3740, 2810, 4100, 33],
  ['hosted', 'Sandpiper RSS', 410, 0, 2700, 21],
  ['hosted', 'Thimble Keyboard', 690, 96, 1900, 26],
  ['hosted', 'Wren Launcher', 540, 0, 880, 17],
  ['hosted', 'Fennel Recipes', 930, 400, null, 12],
  ['codeberg', 'Juniper Forge', 6100, 240, 15800, 41],
  ['codeberg', 'Larch Calendar', 1180, 0, 3300, 22],
  ['codeberg', 'Sorrel Contacts', 760, 610, 2100, 19],
  ['codeberg', 'Plover Weather', 380, 0, 640, 14],
  ['fedora', 'Ferrous Shell', 2890, 1010, null, 58],
  ['fedora', 'Anvil Packager', 4470, 0, null, 49],
  ['fedora', 'Bellows Docs', 9300, 720, null, 36],
];
const findwork = {
  version: 1,
  updatedAt: snapshot.generatedAt,
  language: 'sq',
  sources: {
    hosted: {
      cursor: { page: 3, index: 40 },
      complete: false,
      total: 1829,
      scanned: 0,
      updatedAt: snapshot.generatedAt,
    },
    codeberg: {
      cursor: { page: 1, index: 0 },
      complete: true,
      total: 212,
      scanned: 0,
      updatedAt: snapshot.generatedAt,
    },
    fedora: {
      cursor: { page: 2, index: 10 },
      complete: false,
      total: 133,
      scanned: 0,
      updatedAt: snapshot.generatedAt,
    },
  },
  projects: {},
};
for (const [inst, name, total, translated, stars, languages] of candidates) {
  const base = instances[inst].url;
  findwork.projects[`${inst}:${slug(name)}`] = {
    slug: slug(name),
    name,
    url: `${base}/projects/${slug(name)}/-/sq/`,
    web: stars === null ? '' : `https://github.com/example/${slug(name)}`,
    total,
    translated,
    percent: Math.floor((translated / total) * 1000) / 10,
    started: translated > 0,
    languages,
    stars,
    instance: inst,
    platform: 'weblate',
    scannedAt: snapshot.generatedAt,
  };
  findwork.sources[inst].scanned += 1;
}
// Projects already on the dashboard are in the index too; the page hides them.
for (const [key, g] of groups) {
  const [inst, project] = key.split(':');
  findwork.projects[key] = {
    slug: project,
    name: rows.find((r) => slug(r[1]) === project)[1],
    url: `${instances[inst].url}/projects/${project}/-/sq/`,
    web: '',
    total: g.total,
    translated: g.translated,
    percent: Math.floor((g.translated / g.total) * 1000) / 10,
    started: true,
    languages: 30,
    stars: null,
    instance: inst,
    platform: 'weblate',
    scannedAt: snapshot.generatedAt,
  };
  findwork.sources[inst].scanned += 1;
}

// ---- glossary: short strings, some translated more than one way ----

const termRows = [
  ['Settings', ['Cilësimet', 'Rregullimet', 'Parametrat'], [5, 3, 1]],
  ['Save', ['Ruaj', 'Ruaje'], [6, 2]],
  ['Cancel', ['Anulo', 'Anuloje'], [5, 2]],
  ['Search', ['Kërko', 'Kërkim'], [4, 3]],
  ['Delete', ['Fshi', 'Fshije'], [4, 1]],
  ['Account', ['Llogaria', 'Llogari'], [3, 2]],
  ['About', ['Rreth', 'Rreth nesh'], [3, 1]],
  ['Language', ['Gjuha'], [6]],
  ['Help', ['Ndihmë'], [5]],
  ['Close', ['Mbyll'], [5]],
  ['Share', ['Ndaj'], [3]],
  ['Edit', ['Përpunoni'], [4]],
  ['Dark theme', ['Temë e errët'], [3]],
  ['Sign in', ['Hyni'], [4]],
  ['Notifications', ['Njoftime'], [4]],
];
const glossary = { version: 1, updatedAt: snapshot.generatedAt, sources: {}, units: {} };
let unitId = 71000;
const paths = rows.map(([inst, project, component]) => [
  inst,
  `${slug(project)}/${slug(component)}`,
]);
for (const [source, targets, counts] of termRows) {
  targets.forEach((target, v) => {
    for (let i = 0; i < counts[v]; i += 1) {
      const [inst, path] = paths[(unitId * 7 + v * 3 + i * 5) % paths.length];
      // Real projects vary in case and punctuation; the checker must see through that.
      const form = i % 4 === 3 ? `${source}…` : i % 5 === 4 ? source.toUpperCase() : source;
      glossary.units[`${inst}:${unitId}`] = [form, target, path, iso(1 + ((unitId * 13) % 300))];
      unitId += 1;
    }
  });
}

// ---- alerts: projects that recently gained strings ----

const alerts = {
  version: 1,
  events: [
    ['hosted:quillpad', 'Quillpad', 310, 2353, 68.3, 20],
    ['fedora:harbor-installer', 'Harbor Installer', 42, 663, 75.2, 33],
    ['codeberg:saltmarsh-mail', 'Saltmarsh Mail', 18, 478, 67.9, 47],
  ].map(([project, name, added, waiting, percent, ago]) => ({
    project,
    name,
    added,
    waiting,
    percent,
    url: `${instances[project.split(':')[0]].url}/translate/${project.split(':')[1]}/-/sq/?q=state:empty`,
    at: iso(ago),
  })),
};

const write = (name, value) =>
  writeFile(join(root, 'demo', name), `${JSON.stringify(value, null, 1)}\n`);

const config = {
  language: 'sq',
  usernames: members,
  team: { name: 'Albanian team' },
  instances: Object.keys(instances).map((id) => ({ id })),
};
await mkdir(join(root, 'demo'), { recursive: true });
await writeFile(join(root, 'demo', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
await mkdir(join(root, 'demo', 'history'), { recursive: true });
await write('snapshot.json', snapshot);
await write('activity.json', activity);
await write('alerts.json', alerts);
await writeFile(join(root, 'demo', 'findwork.json'), linesJson(findwork, 'projects'));
await writeFile(join(root, 'demo', 'glossary.json'), linesJson(glossary, 'units'));
await write('history/index.json', { years: ['all'] });
await writeFile(join(root, 'demo', 'history', 'all.json'), stringifyHistory(history));
console.log(`Wrote demo data: ${rows.length} components`);
