// The service worker and the manifest name files; make sure they exist, and
// that every version number in the repository is the same one.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('pwa: every file the service worker caches on install exists', () => {
  const sw = read('sw.js');
  const list = sw.slice(
    sw.indexOf('const SHELL = ['),
    sw.indexOf('];', sw.indexOf('const SHELL = [')),
  );
  const files = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((f) => f !== './');
  assert.ok(files.length > 15);
  for (const file of files)
    assert.ok(existsSync(join(root, file)), `${file} is listed in sw.js but missing`);
  // what the dashboard imports before anything is clicked must be in the list
  for (const module of [
    'src/app.js',
    'src/core.js',
    'src/i18n.js',
    'src/ui.js',
    'src/platforms/index.js',
    'locales/en.json',
  ]) {
    assert.ok(files.includes(module), module);
  }
});

test('pwa: manifest icons and shortcuts point at real things', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  for (const icon of manifest.icons) assert.ok(existsSync(join(root, icon.src)), icon.src);
  const app = read('src/app.js');
  for (const shortcut of manifest.shortcuts) {
    const view = new URLSearchParams(shortcut.url.split('?')[1]).get('view');
    assert.ok(app.includes(`${view}: () => import(`), `shortcut to unknown page "${view}"`);
  }
  const html = read('index.html');
  for (const [, href] of html.matchAll(
    /(?:href|src)="((?:assets|src)\/[^"]+|manifest\.webmanifest)"/g,
  )) {
    assert.ok(existsSync(join(root, href)), href);
  }
});

test('one version everywhere: package, service worker, extension, changelog', () => {
  assert.match(
    read('sw.js'),
    new RegExp(`const VERSION = '${pkg.version.replace(/\./g, '\\.')}';`),
  );
  assert.equal(JSON.parse(read('extension/manifest.json')).version, pkg.version);
  assert.match(read('CHANGELOG.md'), new RegExp(`^## ${pkg.version.replace(/\./g, '\\.')} `, 'm'));
});

test('every page module the router names exists', () => {
  const app = read('src/app.js');
  const pages = [...app.matchAll(/import\('\.\/(views\/\w+\.js)'\)/g)].map((m) => m[1]);
  assert.equal(pages.length, 9);
  for (const page of pages) assert.ok(existsSync(join(root, 'src', page)), page);
});
