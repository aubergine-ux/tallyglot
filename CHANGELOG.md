# Changelog

All notable changes to Tallyglot. Versions follow [semantic versioning](https://semver.org).

## 2.0.0 – 2026-11-13

Tallyglot grows from a personal Weblate dashboard into a toolkit for translators, language
teams and project maintainers. Configurations, snapshots, browser caches and links from 1.0
keep working unchanged; nothing has to be migrated.

### Added

- **More platforms.** Pontoon, Crowdin, Transifex and Lokalise alongside Weblate, behind one
  adapter interface (`src/platforms/`). Every card shows the platform it lives on.
- **History and stats.** The Action records a point per day (`data/history/`) and your
  contribution history (`data/activity.json`). The new Stats page has a contribution calendar,
  completion over time per project and overall, streaks and milestones.
- **Profile card.** A README card in four themes, each with a light and a dark variant paired
  through `<picture>` (`cards/*.svg`).
- **Alerts.** When a project gains untranslated strings: RSS feed (`feed.xml`), Discord or
  Slack webhook, or a GitHub issue. Per-project rules and a daily digest.
- **Find work.** An index of projects with little or no coverage in your language, ranked by
  popularity, grown a little every day and on request.
- **Team page.** Every project of a language team, a leaderboard, recent activity and the
  projects closest to completion, on a shareable address.
- **Glossary and consistency checker.** Terms you translated more than one way across
  projects, with links to each string, a preferred choice, and CSV and TBX export.
- **Review queue.** Failing checks, suggestions, strings marked for editing and comments
  across every platform, each list expandable to the individual strings.
- **Maintainer view.** Coverage of any project across all languages, recently active
  translators, stale languages, and a self-updating README chart and badge (`maintainer/*.svg`).
- **Year in review.** Animated yearly summary with a downloadable share image (PNG or SVG).
- **Achievements.** A short list of milestones, shown on the Stats page, the profile card
  and the portfolio.
- **Portfolio.** A public summary of translation work, printable as PDF and exportable as
  JSON Resume entries.
- **Guided setup.** A page that builds the configuration and walks through forking, with no
  terminal and no file editing.
- **Browser extension** for Chrome and Firefox (`extension/`): translation status of the
  repository you are looking at on GitHub or Codeberg.
- **Command line.** `tallyglot` prints a summary in the terminal, or JSON for scripts.
- **Translatable interface** (`locales/*.json`, i18next JSON v4), **installable PWA** with
  offline support, and an **accessibility pass**: skip link, keyboard-operable charts, names
  for every control, AA contrast, reduced-motion support.

### Changed

- API tokens for the Action are read from `TALLYGLOT_TOKENS`. `WEBLATE_TOKENS` still works.
- The muted text colour is darker in the light theme and lighter in the dark theme, to meet
  WCAG AA contrast.
- Cards always show a platform tag (1.0 showed it only with several instances).
- Components on platforms that report no activity date are never marked stale.
- CI runs the unit tests on Linux, macOS and Windows, and checks formatting.

### Fixed

- A fork no longer inherits the history and alerts of the repository it was forked from.

## 1.0.0 – 2026-11-12

First release: one dashboard for the Weblate components you translate, with badges kept
fresh by a scheduled GitHub Action.
