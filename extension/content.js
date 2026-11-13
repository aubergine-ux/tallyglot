// Content script for GitHub and Codeberg repository pages: a small panel with
// the project's translation status in the user's language.

(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const { PLATFORM_NAMES, parseRepo, summarize } = globalThis.TallyglotDetect;
  const msg = (key, ...args) => api.i18n.getMessage(key, args.map(String)) || key;
  const HOST_ID = 'tallyglot-panel';
  let shownFor = '';

  const ask = (message) =>
    new Promise((resolve) => {
      try {
        const answer = api.runtime.sendMessage(message, (value) => resolve(value ?? null));
        if (answer?.then) answer.then(resolve, () => resolve(null));
      } catch {
        resolve(null);
      }
    });

  /** Links in the README and the sidebar: where projects point at their translation platform. */
  function pageLinks() {
    const scope = document.querySelectorAll(
      'article.markdown-body a[href], .markdown-body a[href], .BorderGrid a[href], #readme a[href], .repository-summary a[href], .repo-description a[href]',
    );
    const links = [...scope].map((a) => a.href);
    // Badges are images inside links, but some READMEs use bare images.
    for (const img of document.querySelectorAll(
      '.markdown-body img[src], .markdown-body img[data-canonical-src]',
    )) {
      links.push(img.dataset.canonicalSrc || img.src);
    }
    return links;
  }

  /** Names in the file listing, used when the forge's API does not answer. */
  function visibleFiles() {
    const rows = document.querySelectorAll(
      'a.Link--primary[href*="/tree/"], a.Link--primary[href*="/blob/"], #repo-files-table .name a, .repo-file-cell a',
    );
    return [...new Set([...rows].map((a) => a.textContent.trim()).filter(Boolean))];
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  }

  function show(repoKey, rows, action) {
    document.getElementById(HOST_ID)?.remove();
    const host = el('div', { id: HOST_ID });
    const root = host.attachShadow({ mode: 'open' });
    root.append(
      el('style', {
        textContent: `
        :host { all: initial; }
        .panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; width: 280px;
          box-sizing: border-box; padding: 12px 14px; border-radius: 12px; border: 1px solid #d8d2c6;
          background: #fff; color: #1d1a16; font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif;
          box-shadow: 0 6px 24px rgb(0 0 0 / .14); }
        .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
        .head strong { font-size: 12px; letter-spacing: .04em; text-transform: uppercase; color: #5d564c; }
        button { all: unset; cursor: pointer; padding: 2px 6px; border-radius: 6px; color: #5d564c; font: inherit; }
        button:hover { background: #ece7dd; }
        button:focus-visible, a:focus-visible { outline: 2px solid #b8400a; outline-offset: 2px; }
        p { margin: 0 0 4px; }
        .main { font-weight: 600; font-size: 14px; }
        .muted { color: #5d564c; }
        .bar { height: 6px; margin: 8px 0; border-radius: 3px; background: #ece7dd; overflow: hidden; }
        .bar span { display: block; height: 100%; background: #e8590c; }
        a.go { display: inline-block; margin-top: 6px; padding: 6px 12px; border-radius: 8px; background: #b8400a;
          color: #fff; font-weight: 600; text-decoration: none; }
        @media (prefers-color-scheme: dark) {
          .panel { background: #1d1b18; color: #f2eee7; border-color: #322e28; box-shadow: none; }
          .head strong, .muted, button { color: #b5ad9f; }
          button:hover, .bar { background: #2d2a25; }
          a.go { background: #ff9d6b; color: #1d1206; }
        }
        @media (prefers-reduced-motion: no-preference) { .panel { animation: in .18s ease-out; } }
        @keyframes in { from { opacity: 0; transform: translateY(6px); } }`,
      }),
    );
    const close = el('button', { type: 'button', textContent: '✕', title: msg('close') });
    close.setAttribute('aria-label', msg('close'));
    close.addEventListener('click', () => {
      host.remove();
      api.storage.local.set({ [`hidden:${repoKey}`]: true });
    });
    const panel = el('section', { className: 'panel' }, [
      el('div', { className: 'head' }, [
        el('strong', { textContent: `Tallyglot · ${msg('title')}` }),
        close,
      ]),
      ...rows,
    ]);
    panel.setAttribute('aria-label', `Tallyglot: ${msg('title')}`);
    if (action) {
      const go = el('a', {
        className: 'go',
        href: action.href,
        textContent: action.label,
        target: '_blank',
        rel: 'noopener',
      });
      panel.append(go);
    }
    root.append(panel);
    document.body.append(host);
  }

  const line = (text, className = '') => el('p', { textContent: text, className });
  function bar(percent) {
    const fill = el('span');
    fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    const track = el('div', { className: 'bar' }, [fill]);
    track.setAttribute('role', 'img');
    track.setAttribute('aria-label', `${percent}%`);
    return track;
  }

  async function run() {
    const repo = parseRepo(location.href);
    const key = repo ? `${repo.host}/${repo.owner}/${repo.repo}` : '';
    if (!repo || !repo.root) {
      document.getElementById(HOST_ID)?.remove();
      shownFor = '';
      return;
    }
    if (shownFor === key && document.getElementById(HOST_ID)) return;
    shownFor = key;
    const store = await api.storage.local.get([`hidden:${key}`, 'language']);
    if (store[`hidden:${key}`]) return;
    const language = (store.language || '').trim();

    const files = (await ask({ type: 'files', repo })) || visibleFiles();
    if (shownFor !== key) return; // the visitor moved on while we waited
    const found = summarize(pageLinks(), files);
    if (found.kind === 'none') return;

    if (found.kind === 'files') {
      show(key, [
        line(msg('noPlatform'), 'main'),
        line(msg('noPlatformHint', found.example), 'muted'),
      ]);
      return;
    }
    const name = PLATFORM_NAMES[found.platform];
    if (found.kind === 'config') {
      show(key, [line(msg('translatedOn', name), 'main'), line(msg('configOnly', name), 'muted')]);
      return;
    }
    if (!language) {
      show(key, [line(msg('translatedOn', name), 'main'), line(msg('setLanguage'), 'muted')], {
        href: found.url,
        label: msg('openOn', name),
      });
      return;
    }
    const status = await ask({ type: 'status', found, language });
    if (shownFor !== key) return;
    if (!status) {
      show(key, [line(msg('translatedOn', name), 'main'), line(msg('statusUnknown'), 'muted')], {
        href: found.url,
        label: msg('openOn', name),
      });
    } else if (!status.started) {
      show(
        key,
        [line(msg('notStarted', language), 'main'), line(msg('translatedOn', name), 'muted')],
        {
          href: found.url,
          label: msg('start'),
        },
      );
    } else {
      show(
        key,
        [
          line(msg('status', language, status.percent), 'main'),
          bar(status.percent),
          line(
            status.left
              ? msg('left', new Intl.NumberFormat().format(status.left))
              : msg('complete'),
            'muted',
          ),
          line(msg('translatedOn', name), 'muted'),
        ],
        { href: status.url || found.url, label: msg('translate') },
      );
    }
  }

  run();
  // Both forges swap pages without a full load.
  for (const event of ['turbo:load', 'pjax:end', 'popstate']) {
    document.addEventListener(event, run);
    addEventListener(event, run);
  }
})();
