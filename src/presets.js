// The repository new dashboards are forked from.
export const UPSTREAM = 'aubergine-ux/tallyglot';

// Well-known public Weblate instances. Any other instance can be added by URL.
export const PRESETS = [
  { id: 'hosted', name: 'Hosted Weblate', url: 'https://hosted.weblate.org' },
  { id: 'codeberg', name: 'Codeberg Translate', url: 'https://translate.codeberg.org' },
  { id: 'fedora', name: 'Fedora Weblate', url: 'https://translate.fedoraproject.org' },
];

// Name and default address of every supported platform. Weblate is self-hosted,
// so each Weblate instance brings its own address.
export const PLATFORM_META = {
  weblate: { name: 'Weblate', url: '' },
  pontoon: { name: 'Pontoon', url: 'https://pontoon.mozilla.org' },
  crowdin: { name: 'Crowdin', url: 'https://api.crowdin.com' },
  transifex: { name: 'Transifex', url: 'https://rest.api.transifex.com' },
  lokalise: { name: 'Lokalise', url: 'https://api.lokalise.com' },
};

export function slugifyId(text) {
  return (
    String(text || '')
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'instance'
  );
}
