# Translating Tallyglot

The interface strings live in [`locales/`](../locales), one JSON file per language, in the
**i18next JSON v4** format: nested keys, `{{variables}}`, and `_one` / `_other` suffixes for
plurals (your language's own plural categories, such as `_few` and `_many`, work too).

## Add or improve a language

1. Copy `locales/en.json` to `locales/<code>.json`, for example `locales/sq.json`.
2. Translate the values. Leave keys, `{{variables}}` and HTML tags as they are. A string you
   leave out falls back to English, so a partial translation is useful.
3. Add the language to `locales/index.json`, with its name written in that language:
   ```json
   { "en": "English", "sq": "Shqip" }
   ```
4. Run `npm test`. It checks that every file parses and that placeholders are intact.
5. Preview with `npm start`, then open `http://127.0.0.1:8080/?demo&lang=<code>`.

The language can be chosen under **Settings → Interface language**. By default Tallyglot
follows the browser's language.

## Using a translation platform

The files work with any platform that reads i18next JSON. To set Tallyglot up as a Weblate
component:

| Setting | Value |
|---|---|
| File format | i18next JSON file v4 |
| File mask | `locales/*.json` |
| Monolingual base language file | `locales/en.json` |
| Template for new translations | `locales/en.json` |
| Language filter | `^(?!index$).+$` (so `index.json` is not taken for a language) |

New languages created on the platform still need their line in `locales/index.json`.

Once the component exists, pin it in `tallyglot.config.json` to see Tallyglot track its own
translation:

```json
{ "id": "hosted", "pinned": ["<project>/<component>"] }
```

## Notes for translators

- `{{count}}` is replaced by a number already formatted for your language.
- Strings may contain simple HTML such as `<strong>` or `<code>`; keep the tags.
- The browser extension has its own, much smaller file:
  `extension/_locales/en/messages.json` (WebExtension format). Copy the `en` folder to your
  language code to translate it.
- Text inside generated images (badges, profile card, README charts) is English only for now.
