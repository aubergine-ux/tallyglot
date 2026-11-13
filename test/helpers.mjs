// Shared test helpers: fixtures and a fetch stand-in that serves them.

import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from '../scripts/build-data.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const fixture = (name) => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));

/**
 * routes: [[test, body], …] where test is a string the URL must contain or a
 * RegExp, and body is JSON, a status number, or a function of the URL.
 * The first match wins. Every request is pushed to `log` as { url, headers }.
 */
export function fakeFetch(routes, log = []) {
  return async (url, init = {}) => {
    const decoded = decodeURIComponent(url);
    log.push({ url: decoded, headers: init.headers || {} });
    const hit = routes.find(([test]) =>
      test instanceof RegExp ? test.test(decoded) : decoded.includes(test),
    );
    let body = hit ? hit[1] : 404;
    if (typeof body === 'function') body = body(new URL(url));
    const status = typeof body === 'number' ? body : 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => (status === 429 && name === 'Retry-After' ? '120' : null) },
      json: async () => (typeof body === 'number' ? {} : body),
    };
  };
}

/* ---------- running the Action's script in a temporary repository ---------- */

export const NOW = new Date('2026-11-12T12:00:00Z').getTime();
const T = 'https://hosted.weblate.org/api/translations/trale/localizations/sq/';

export async function repo(config, files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tallyglot-build-'));
  await writeFile(join(root, 'tallyglot.config.json'), JSON.stringify(config));
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), typeof body === 'string' ? body : JSON.stringify(body));
  }
  const read = async (path) => JSON.parse(await readFile(join(root, path), 'utf8'));
  return { root, read, text: (path) => readFile(join(root, path), 'utf8') };
}

export const routes = (overrides = []) => [
  ...overrides,
  [
    '/api/changes/',
    (url) =>
      url.searchParams.get('timestamp_after')
        ? { results: [], next: null }
        : { ...fixture('weblate-changes'), next: null },
  ],
  [`${T}statistics/`, fixture('weblate-translation-statistics')],
  [T, fixture('weblate-translation-trale-localizations-sq')],
  ['/api/v2/locales/sq/', fixture('pontoon-locale-sq')],
  ['/projects/4242/languages/progress', fixture('crowdin-progress')],
  ['/api/v2/projects/4242', fixture('crowdin-project')],
];

export const CONFIG = {
  language: 'sq',
  usernames: ['aubergine-ux'],
  instances: [
    { id: 'hosted' },
    { platform: 'pontoon', projects: ['firefox', 'amo'] },
    { platform: 'crowdin', projects: ['4242'] },
  ],
};

export const run = (r, opts = {}) =>
  build({
    root: r.root,
    fetch: fakeFetch(opts.routes || routes()),
    env: { TALLYGLOT_TOKENS: '{"crowdin":"tok"}', ...opts.env },
    now: opts.now ?? NOW,
    log: opts.log || (() => {}),
  });
