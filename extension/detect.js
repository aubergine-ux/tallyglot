// Works out how a repository is translated, from what is visible about it:
// the links in its README and the names of its files. No DOM, no network.
//
// Loaded three ways: as a content script, in the background worker, and by
// the tests (as a module), so it attaches itself to globalThis.

(() => {
  const PLATFORM_NAMES = {
    weblate: 'Weblate',
    crowdin: 'Crowdin',
    transifex: 'Transifex',
    pontoon: 'Pontoon',
    lokalise: 'Lokalise',
  };

  // Pages under these first path segments are not repositories.
  const RESERVED = new Set([
    'settings',
    'orgs',
    'organizations',
    'explore',
    'marketplace',
    'notifications',
    'issues',
    'pulls',
    'search',
    'login',
    'join',
    'sponsors',
    'topics',
    'collections',
    'features',
    'about',
    'user',
    'users',
    'admin',
    'repo',
    'api',
    'assets',
    'new',
    'codespaces',
    'apps',
    'trending',
  ]);

  /** { host, owner, repo, root } for a GitHub or Codeberg repository page, else null. */
  function parseRepo(href) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    if (!['github.com', 'codeberg.org'].includes(url.hostname)) return null;
    const [owner, repo, ...rest] = url.pathname.split('/').filter(Boolean);
    if (!owner || !repo || RESERVED.has(owner.toLowerCase())) return null;
    return {
      host: url.hostname,
      owner,
      repo: repo.replace(/\.git$/, ''),
      // The panel is shown on the repository's front page and its code views.
      root: rest.length === 0 || ['tree', 'src'].includes(rest[0]),
    };
  }

  const WEBLATE_PATHS = /^\/(?:engage|projects|widgets?|translate)\/([^/]+)\//;

  /**
   * Translation platforms linked from a README or sidebar.
   * @param {string[]} links absolute URLs
   * @returns {{platform: string, base?: string, project: string, url: string}[]} most telling first
   */
  function findPlatforms(links) {
    const found = new Map();
    const add = (platform, project, url, base) => {
      const key = `${platform}:${base || ''}:${project.toLowerCase()}`;
      if (!found.has(key)) found.set(key, { platform, project, url, ...(base ? { base } : {}) });
    };
    for (const link of links) {
      let u;
      try {
        u = new URL(link);
      } catch {
        continue;
      }
      const host = u.hostname.toLowerCase();
      const parts = u.pathname.split('/').filter(Boolean);
      if (host === 'crowdin.com' && parts[0] === 'project' && parts[1]) {
        add('crowdin', parts[1], `https://crowdin.com/project/${parts[1]}`);
      } else if (
        /^[\w-]+\.crowdin\.com$/.test(host) &&
        host !== 'badges.crowdin.com' &&
        host !== 'support.crowdin.com' &&
        host !== 'api.crowdin.com'
      ) {
        add('crowdin', host.split('.')[0], `https://${host}/`);
      } else if (host === 'badges.crowdin.net' && parts[0]) {
        add('crowdin', parts[0], `https://crowdin.com/project/${parts[0]}`);
      } else if (
        /^(app|www|explore)\.transifex\.com$/.test(host) &&
        parts[1] &&
        !['signin', 'signup'].includes(parts[0])
      ) {
        add(
          'transifex',
          `${parts[0]}/${parts[1]}`,
          `https://app.transifex.com/${parts[0]}/${parts[1]}/`,
        );
      } else if (host === 'pontoon.mozilla.org') {
        const project =
          parts[0] === 'projects' ? parts[1] : parts[1] && parts[0] !== 'api' ? parts[1] : null;
        if (project)
          add(
            'pontoon',
            project,
            `https://pontoon.mozilla.org/projects/${project}/`,
            'https://pontoon.mozilla.org',
          );
      } else if (host === 'app.lokalise.com' && parts[0] === 'public' && parts[1]) {
        add('lokalise', parts[1], `https://app.lokalise.com/public/${parts[1]}/`);
      } else {
        // Weblate can live on any host; its addresses are recognisable.
        const m = WEBLATE_PATHS.exec(u.pathname);
        const looksLikeWeblate =
          /weblate|translate\./.test(host) || u.pathname.startsWith('/engage/');
        if (m && looksLikeWeblate && m[1] !== '-') {
          const base = `${u.protocol}//${u.host}`;
          add('weblate', decodeURIComponent(m[1]), `${base}/engage/${m[1]}/`, base);
        }
      }
    }
    return [...found.values()];
  }

  const CONFIG_FILES = [
    [/(^|\/)\.weblate$/, 'weblate'],
    [/(^|\/)crowdin\.ya?ml$/, 'crowdin'],
    [/(^|\/)\.tx\/config$/, 'transifex'],
    [/(^|\/)\.tx$/, 'transifex'],
    [/(^|\/)lokalise\.ya?ml$/, 'lokalise'],
    [/(^|\/)l10n\.toml$/, 'pontoon'],
  ];

  const TRANSLATION_FILES = [
    /\.pot?$/,
    /\.xlf$|\.xliff$/,
    /\.arb$/,
    /(^|\/)values-[a-z]{2,3}(-r[A-Z]{2}|-[A-Za-z0-9]+)?\/strings\.xml$/,
    /(^|\/)[a-z]{2,3}([-_][A-Za-z]{2,4})?\.lproj\//,
    /(^|\/)(locales?|i18n|l10n|lang|langs|languages|translations?)\/.*\.(json|ya?ml|properties|ts|ini|toml|php|strings|ftl|resx)$/i,
    /(^|\/)messages_[a-z]{2}(_[A-Z]{2})?\.properties$/,
    /\.[a-z]{2}(-[A-Z]{2})?\.resx$/,
  ];
  // Folder names that suggest translations when only the top level is visible.
  const TRANSLATION_DIRS = /^(po|locales?|i18n|l10n|lang|langs|languages|translations?)$/i;

  /**
   * What the file names say.
   * @param {string[]} paths file paths, or just the top-level names
   * @returns {{configs: string[], translationFiles: boolean, example: string}}
   */
  function inspectFiles(paths) {
    const configs = new Set();
    let example = '';
    for (const path of paths) {
      for (const [pattern, platform] of CONFIG_FILES) if (pattern.test(path)) configs.add(platform);
      if (
        !example &&
        (TRANSLATION_FILES.some((p) => p.test(path)) || TRANSLATION_DIRS.test(path))
      ) {
        example = path;
      }
    }
    return { configs: [...configs], translationFiles: !!example, example };
  }

  /**
   * Put the evidence together.
   * @returns {{kind: 'platform', platform, project, url, base?} |
   *           {kind: 'config', platform} | {kind: 'files', example} | {kind: 'none'}}
   */
  function summarize(links, paths) {
    const platforms = findPlatforms(links);
    const files = inspectFiles(paths);
    if (platforms.length) {
      // A link that agrees with a config file in the repository wins.
      const best = platforms.find((p) => files.configs.includes(p.platform)) || platforms[0];
      return { kind: 'platform', ...best };
    }
    if (files.configs.length) return { kind: 'config', platform: files.configs[0] };
    if (files.translationFiles) return { kind: 'files', example: files.example };
    return { kind: 'none' };
  }

  const sameLanguage = (a, b) =>
    String(a).toLowerCase().replace(/_/g, '-') === String(b).toLowerCase().replace(/_/g, '-');

  /** Pick the user's language out of Weblate's /projects/<p>/languages/ answer. */
  function weblateStatus(rows, language) {
    const size = Math.max(0, ...rows.map((r) => r.total || 0));
    const mine = rows.find((r) => sameLanguage(r.code, language));
    if (!mine) return { started: false, percent: 0, left: size, url: null };
    return {
      started: true,
      percent: mine.translated_percent,
      left: Math.max(0, mine.total - mine.translated),
      url: mine.translate_url || mine.url || null,
    };
  }

  /** The same for Pontoon's /api/v2/<locale>/<project>/ answer. */
  function pontoonStatus(body, language, project) {
    const total = body.total_strings || 0;
    return {
      started: true,
      percent: total ? Math.floor((body.completed_strings / total) * 1000) / 10 : 0,
      left: body.missing_strings || 0,
      url: `https://pontoon.mozilla.org/${String(language).replace(/_/g, '-')}/${project}/`,
    };
  }

  globalThis.TallyglotDetect = {
    PLATFORM_NAMES,
    parseRepo,
    findPlatforms,
    inspectFiles,
    summarize,
    weblateStatus,
    pontoonStatus,
  };
})();
