# API fixtures

Responses the platform adapters are tested against.

| Files | Origin |
|---|---|
| `weblate-*.json` | Recorded from `hosted.weblate.org` on 2026-11-12, lists shortened. |
| `pontoon-*.json` | Recorded from `pontoon.mozilla.org` on 2026-11-12, lists shortened. |
| `crowdin-*.json`, `transifex-*.json`, `lokalise-*.json` | Written by hand after each platform's API reference, because these APIs answer only with a token. Replace them with recordings when you have one: `node scripts/record-fixtures.mjs`. |
