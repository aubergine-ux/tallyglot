// Well-known public Weblate instances. Any other instance can be added by URL.
export const PRESETS = [
  { id: 'hosted', name: 'Hosted Weblate', url: 'https://hosted.weblate.org' },
  { id: 'codeberg', name: 'Codeberg Translate', url: 'https://translate.codeberg.org' },
  { id: 'fedora', name: 'Fedora Weblate', url: 'https://translate.fedoraproject.org' },
];

export function slugifyId(text) {
  return (
    String(text || '')
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'instance'
  );
}
