#!/usr/bin/env node
// Regenerates the sample data behind ?demo (demo/config.json, demo/snapshot.json).
// The projects are made up; nothing here is fetched from a real instance.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    suggestions: 0,
    lastChange: iso(active),
    lastContribution: iso(own),
    webUrl: `${base}/projects/${path}/sq/`,
    translateUrl: `${base}/translate/${path}/sq/`,
    pinned,
    fetchedAt: snapshot.generatedAt,
  });
}

const config = {
  language: 'sq',
  usernames: ['demo'],
  instances: Object.keys(instances).map((id) => ({ id })),
};
await mkdir(join(root, 'demo'), { recursive: true });
await writeFile(join(root, 'demo', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
await writeFile(join(root, 'demo', 'snapshot.json'), `${JSON.stringify(snapshot, null, 1)}\n`);
console.log(`Wrote demo data: ${rows.length} components`);
