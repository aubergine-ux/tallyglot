// Local servers for end-to-end tests: the app itself, and a fake Weblate API.

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml',
};

const listen = (server, port = 0) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });

/**
 * Serves the repository. `overrides` maps a path to a JSON body (or null for 404).
 * `close()` also drops open connections, so the browser sees the site go away.
 */
export async function startApp(overrides = {}, port = 0) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path in overrides) {
      const body = overrides[path];
      res.writeHead(body === null ? 404 : 200, { 'Content-Type': 'application/json' });
      res.end(body === null ? '' : JSON.stringify(body));
      return;
    }
    const file = join(root, normalize(path === '/' ? '/index.html' : path));
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  const bound = await listen(server, port);
  return {
    url: `http://127.0.0.1:${bound}`,
    port: bound,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

/**
 * A fake Crowdin API serving the fixtures in test/fixtures. Requests without a
 * bearer token get HTTP 401, like the real one.
 */
export async function startCrowdin() {
  const fixture = async (name) =>
    JSON.parse(await readFile(join(root, 'test', 'fixtures', `${name}.json`), 'utf8'));
  const state = { requests: [] };
  const server = createServer(async (req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, accept',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(200, cors);
      res.end();
      return;
    }
    const path = new URL(req.url, 'http://x').pathname;
    state.requests.push({ path, auth: req.headers.authorization || null });
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(body));
    };
    if (!req.headers.authorization) return send(401, { error: { message: 'Unauthorized' } });
    if (path === '/api/v2/projects/4242') return send(200, await fixture('crowdin-project'));
    if (path === '/api/v2/projects/4242/languages/progress') {
      return send(200, await fixture('crowdin-progress'));
    }
    return send(404, { error: { message: 'Project Not Found' } });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, state, close: () => server.close() };
}

/**
 * A fake Weblate with three Albanian translations for user "alice".
 * `state.mode`: 'ok' | 'limit' (HTTP 429) | 'error' (HTTP 500); `state.delay` in ms.
 */
export async function startWeblate() {
  const state = { mode: 'ok', delay: 0, requests: [] };
  let base = '';
  const translation = (project, component, total, translated, fuzzy, review, last) => ({
    language_code: 'sq',
    language: { name: 'Albanian' },
    component: {
      slug: component,
      name: component[0].toUpperCase() + component.slice(1),
      project: {
        slug: project,
        name: project[0].toUpperCase() + project.slice(1),
        web_url: `${base}/projects/${project}/`,
        translation_review: review,
      },
    },
    total,
    translated,
    fuzzy,
    translated_percent: Math.floor((translated / total) * 1000) / 10,
    failing_checks: 2,
    have_suggestion: 0,
    have_comment: component === 'docs' ? 1 : 0,
    last_change: last,
    web_url: `${base}/projects/${project}/${component}/sq/`,
    translate_url: `${base}/translate/${project}/${component}/sq/`,
  });
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, accept',
      'Access-Control-Expose-Headers': 'Retry-After',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(200, cors);
      res.end();
      return;
    }
    state.requests.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      auth: req.headers.authorization || null,
    });
    if (state.delay) await new Promise((r) => setTimeout(r, state.delay));
    const json = (status, body, extra = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...cors, ...extra });
      res.end(JSON.stringify(body));
    };
    if (state.mode === 'limit')
      return json(429, { detail: 'throttled' }, { 'Retry-After': '1800' });
    if (state.mode === 'error') return json(500, { detail: 'boom' });

    const t = (p, c) => `${base}/api/translations/${p}/${c}/sq/`;
    const routes = {
      '/api/changes/': () =>
        url.searchParams.get('user') === 'alice' && !url.searchParams.get('timestamp_after')
          ? {
              next: null,
              results: [
                { translation: t('alpha', 'ui'), timestamp: daysAgo(1) },
                { translation: t('alpha', 'docs'), timestamp: daysAgo(50) },
                { translation: t('beta', 'app'), timestamp: daysAgo(3) },
                { translation: `${base}/api/translations/alpha/ui/de/`, timestamp: daysAgo(2) },
              ],
            }
          : { next: null, results: [] },
      '/api/translations/alpha/ui/sq/': () =>
        translation('alpha', 'ui', 200, 190, 4, false, daysAgo(1)),
      '/api/translations/alpha/docs/sq/': () =>
        translation('alpha', 'docs', 1000, 400, 0, false, daysAgo(45)),
      '/api/translations/beta/app/sq/': () =>
        translation('beta', 'app', 50, 50, 0, true, daysAgo(3)),
      '/api/translations/beta/app/sq/statistics/': () => ({ approved: 40, approved_percent: 80 }),
      '/api/projects/': () => ({
        count: 2,
        next: null,
        results: ['alpha', 'delta'].map((slug) => ({
          slug,
          name: slug[0].toUpperCase() + slug.slice(1),
          web: '',
          web_url: `${base}/projects/${slug}/`,
        })),
      }),
      '/api/projects/alpha/': () => ({
        slug: 'alpha',
        name: 'Alpha',
        web: 'https://github.com/example/alpha',
        web_url: `${base}/projects/alpha/`,
      }),
      '/api/projects/alpha/changes/': () => ({
        next: null,
        results: [
          ['alice', 'sq', 1],
          ['alice', 'sq', 2],
          ['bruno', 'de', 5],
          ['weblate:push', 'de', 1],
        ].map(([user, lang, days]) => ({
          user: `${base}/api/users/${user}/`,
          translation: `${base}/api/translations/alpha/ui/${lang}/`,
          timestamp: daysAgo(days),
        })),
      }),
      '/api/projects/alpha/languages/': () => [
        {
          code: 'sq',
          name: 'Albanian',
          last_change: daysAgo(200),
          total: 1200,
          translated: 590,
          translated_percent: 49.1,
          url: `${base}/projects/alpha/-/sq/`,
        },
        {
          code: 'de',
          name: 'German',
          total: 1200,
          translated: 1200,
          translated_percent: 100,
          url: `${base}/projects/alpha/-/de/`,
          last_change: daysAgo(300),
        },
      ],
      '/api/projects/delta/languages/': () => [
        { code: 'de', total: 800, translated: 640, translated_percent: 80 },
        { code: 'fr', total: 800, translated: 100, translated_percent: 12.5 },
      ],
      '/api/translations/alpha/ui/sq/units/': () => ({
        count: url.searchParams.get('q') === 'has:check' ? 2 : 0,
        results:
          url.searchParams.get('q') === 'has:check'
            ? [
                {
                  source: ['Open file'],
                  target: ['Hap kartelë'],
                  web_url: `${base}/translate/alpha/ui/sq/?checksum=1`,
                },
                {
                  source: ['Save <b>all</b>'],
                  target: [''],
                  web_url: `${base}/translate/alpha/ui/sq/?checksum=2`,
                },
              ]
            : [],
      }),
      '/api/translations/gamma/extra/sq/': () =>
        translation('gamma', 'extra', 10, 0, 0, false, daysAgo(400)),
    };
    const route = routes[url.pathname];
    return route ? json(200, route()) : json(404, { detail: 'Not found.' });
  });
  const port = await listen(server);
  base = `http://127.0.0.1:${port}`;
  return { url: base, state, close: () => server.close() };
}
