# Tallyglot browser extension

On a GitHub or Codeberg repository page, shows a small panel with the project's translation
status in your language and a link straight to the translation platform.

| The repository… | The panel says |
|---|---|
| links to a Weblate or Pontoon project | `sq: 96.6% translated · 9 strings left`, with a **Translate** button |
| links to Crowdin, Transifex or Lokalise | which platform it is, with a link (their APIs need a token, so no numbers) |
| has a platform's config file but no link | which platform it uses |
| has translation files and no platform | that translating means opening a pull request |
| has nothing to translate | nothing; no panel is shown |

## Install

The extension is not in the browser stores. Load it from this folder:

- **Chrome, Edge, Brave:** open `chrome://extensions`, turn on **Developer mode**, choose
  **Load unpacked** and select the `extension` folder.
- **Firefox:** open `about:debugging#/runtime/this-firefox`, choose **Load Temporary
  Add-on** and select `extension/manifest.json`. Firefox removes temporary add-ons when it
  closes.

Then click the Tallyglot icon in the toolbar and enter your language code.

## What it accesses

- It reads the README links and file names of the repository page you are on.
- It asks `api.github.com` or `codeberg.org` for the repository's file list, and the
  translation platform (Hosted Weblate, Codeberg Translate, Fedora Weblate, Pontoon) for the
  project's statistics. Answers are kept for six hours.
- Weblate instances on other addresses are recognised and linked, without numbers.
- It stores your language, an optional dashboard address and which panels you closed. It
  sends nothing anywhere else.

## Files

```
manifest.json    Manifest V3, for Chrome and Firefox
detect.js        what a repository's links and files say (no DOM, no network; unit tested)
content.js       the panel
background.js    requests to forges and platforms, with a cache
options.html/js  toolbar popup and options
_locales/        interface strings
```

Tests: `npm test` covers `detect.js` and the manifest; `node e2e/extension.mjs` loads the
extension in headless Chromium and renders the panel for each case.
