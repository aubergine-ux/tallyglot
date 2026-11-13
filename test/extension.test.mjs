import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import '../extension/detect.js';
import { fixture } from './helpers.mjs';

const { parseRepo, findPlatforms, inspectFiles, summarize, weblateStatus, pontoonStatus } =
  globalThis.TallyglotDetect;
const dir = fileURLToPath(new URL('../extension/', import.meta.url));

test('extension: repository pages are recognised, everything else is left alone', () => {
  assert.deepEqual(parseRepo('https://github.com/QuantumPhysique/trale'), {
    host: 'github.com',
    owner: 'QuantumPhysique',
    repo: 'trale',
    root: true,
  });
  assert.equal(parseRepo('https://github.com/a/b/tree/main/app').root, true);
  assert.equal(parseRepo('https://codeberg.org/a/b/src/branch/main').root, true);
  assert.equal(parseRepo('https://github.com/a/b/issues/3').root, false);
  assert.equal(parseRepo('https://github.com/a/b.git').repo, 'b');
  for (const no of [
    'https://github.com/',
    'https://github.com/alice',
    'https://github.com/settings/profile',
    'https://github.com/orgs/x/people',
    'https://gitlab.com/a/b',
    'https://example.org/a/b',
    'not a url',
    '',
  ]) {
    assert.equal(parseRepo(no), null, no);
  }
});

test('extension: platform links in a README', () => {
  const found = findPlatforms([
    'https://hosted.weblate.org/engage/trale/',
    'https://hosted.weblate.org/widget/trale/localizations/svg-badge.svg',
    'https://translate.codeberg.org/projects/forgejo/',
    'https://weblate.example.org/projects/thing/main/',
    'https://crowdin.com/project/kestrel-notes',
    'https://badges.crowdin.net/kestrel-notes/localized.svg',
    'https://acme.crowdin.com/app',
    'https://app.transifex.com/heron/heron-desktop/dashboard/',
    'https://explore.transifex.com/heron/heron-desktop/',
    'https://pontoon.mozilla.org/projects/firefox-for-android/',
    'https://pontoon.mozilla.org/sq/thunderbird/',
    'https://app.lokalise.com/public/123456.789/',
    // none of these are translation projects
    'https://example.org/projects/x/',
    'https://crowdin.com/',
    'https://crowdin.com/pricing',
    'https://app.transifex.com/signin/',
    'https://hosted.weblate.org/',
    'https://support.crowdin.com/x/y',
    'https://hosted.weblate.org/projects/-/x/',
    'mailto:x@example.org',
    'nonsense',
  ]);
  assert.deepEqual(
    found.map((f) => [f.platform, f.project, f.url]),
    [
      ['weblate', 'trale', 'https://hosted.weblate.org/engage/trale/'],
      ['weblate', 'forgejo', 'https://translate.codeberg.org/engage/forgejo/'],
      ['weblate', 'thing', 'https://weblate.example.org/engage/thing/'],
      ['crowdin', 'kestrel-notes', 'https://crowdin.com/project/kestrel-notes'],
      ['crowdin', 'acme', 'https://acme.crowdin.com/'],
      ['transifex', 'heron/heron-desktop', 'https://app.transifex.com/heron/heron-desktop/'],
      [
        'pontoon',
        'firefox-for-android',
        'https://pontoon.mozilla.org/projects/firefox-for-android/',
      ],
      ['pontoon', 'thunderbird', 'https://pontoon.mozilla.org/projects/thunderbird/'],
      ['lokalise', '123456.789', 'https://app.lokalise.com/public/123456.789/'],
    ],
  );
  assert.equal(found[0].base, 'https://hosted.weblate.org');
  assert.deepEqual(findPlatforms([]), []);
});

test('extension: config files and translation files', () => {
  assert.deepEqual(inspectFiles(['README.md', 'crowdin.yml', 'src/main.c']), {
    configs: ['crowdin'],
    translationFiles: false,
    example: '',
  });
  assert.deepEqual(
    inspectFiles(['.tx/config', '.weblate', 'docs/lokalise.yaml', 'l10n.toml']).configs,
    ['transifex', 'weblate', 'lokalise', 'pontoon'],
  );
  const yes = [
    'po/de.po',
    'po/app.pot',
    'app/src/main/res/values-sq/strings.xml',
    'app/src/main/res/values-pt-rBR/strings.xml',
    'lib/l10n/app_sq.arb',
    'ios/sq.lproj/Localizable.strings',
    'src/locales/sq.json',
    'i18n/pt_BR.yml',
    'resources/messages_de.properties',
    'translations/app_de.ts',
    'Strings.de.resx',
    'web/locale/fr/app.ftl',
    'x.xliff',
  ];
  for (const path of yes) assert.equal(inspectFiles([path]).translationFiles, true, path);
  const no = [
    'src/main.ts',
    'README.md',
    'app/src/main/res/values/strings.xml',
    'package.json',
    'docs/locale.md',
    'src/translate.js',
    'config.properties',
    'popular.py',
    'app/values-night/colors.xml',
  ];
  for (const path of no) assert.equal(inspectFiles([path]).translationFiles, false, path);
  // only the top level is visible when the forge's API does not answer
  assert.equal(inspectFiles(['src', 'po', 'README.md']).example, 'po');
  assert.equal(inspectFiles(['src', 'Locales']).translationFiles, true);
  assert.deepEqual(inspectFiles([]), { configs: [], translationFiles: false, example: '' });
});

test('extension: the verdict for a repository', () => {
  assert.deepEqual(summarize([], ['src/a.c']), { kind: 'none' });
  assert.deepEqual(summarize([], ['po/de.po']), { kind: 'files', example: 'po/de.po' });
  assert.deepEqual(summarize([], ['crowdin.yml', 'po/de.po']), {
    kind: 'config',
    platform: 'crowdin',
  });
  const linked = summarize(['https://hosted.weblate.org/engage/trale/'], ['lib/l10n/app_sq.arb']);
  assert.deepEqual(
    [linked.kind, linked.platform, linked.project],
    ['platform', 'weblate', 'trale'],
  );
  // a README that mentions two platforms: the one configured in the repository wins
  const both = summarize(
    ['https://hosted.weblate.org/engage/other/', 'https://crowdin.com/project/mine'],
    ['crowdin.yml'],
  );
  assert.deepEqual([both.platform, both.project], ['crowdin', 'mine']);
});

test('extension data source: status from recorded Weblate and Pontoon responses', () => {
  const rows = fixture('weblate-project-languages-trale');
  const sq = weblateStatus(rows, 'sq');
  assert.deepEqual([sq.started, sq.percent, sq.left], [true, 96.6, 9]);
  assert.equal(sq.url, 'https://hosted.weblate.org/translate/trale/-/sq/');
  assert.equal(weblateStatus(rows, 'ZH-hans').started, true); // zh_Hans, however it is typed
  assert.deepEqual(weblateStatus(rows, 'xx'), { started: false, percent: 0, left: 272, url: null });
  assert.deepEqual(weblateStatus([], 'sq'), { started: false, percent: 0, left: 0, url: null });
  const pl = fixture('pontoon-project-firefox-for-android').localizations.find(
    (l) => l.locale.code === 'sq',
  );
  assert.deepEqual(pontoonStatus(pl, 'sq', 'firefox-for-android'), {
    started: true,
    percent: 89.6,
    left: 269,
    url: 'https://pontoon.mozilla.org/sq/firefox-for-android/',
  });
  assert.equal(pontoonStatus({}, 'pt_BR', 'x').url, 'https://pontoon.mozilla.org/pt-BR/x/');
});

test('extension: manifest is consistent with the files and the messages', () => {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, pkg.version);
  const files = new Set(readdirSync(dir));
  const referenced = [
    ...Object.values(manifest.icons),
    manifest.action.default_popup,
    manifest.options_ui.page,
    manifest.background.service_worker,
    ...manifest.background.scripts,
    ...manifest.content_scripts.flatMap((c) => c.js),
  ];
  for (const file of referenced) assert.ok(files.has(file), `${file} is missing`);
  // Firefox runs the listed background scripts; Chrome the worker, which imports detect.js itself
  assert.deepEqual(manifest.background.scripts, ['detect.js', 'background.js']);
  assert.match(readFileSync(join(dir, 'background.js'), 'utf8'), /importScripts\('detect\.js'\)/);
  assert.ok(manifest.browser_specific_settings.gecko.id);

  const messages = JSON.parse(readFileSync(join(dir, '_locales/en/messages.json'), 'utf8'));
  const used = new Set();
  for (const file of ['content.js', 'options.js', 'options.html', 'manifest.json']) {
    const text = readFileSync(join(dir, file), 'utf8');
    const pattern = /msg\('(\w+)'|data-msg="(\w+)"|__MSG_(\w+)__|getMessage\('(\w+)'/g;
    for (const m of text.matchAll(pattern)) {
      const key = m[1] || m[2] || m[3] || m[4];
      used.add(key);
      assert.ok(messages[key], `message "${key}" used in ${file} is not defined`);
    }
  }
  assert.deepEqual(
    Object.keys(messages).filter((k) => !used.has(k)),
    [],
  );
});
