// Background worker: the only part that talks to other sites. Answers the
// content script's questions and keeps the answers for a few hours.

if (typeof importScripts === 'function') importScripts('detect.js'); // Chrome; Firefox lists it in the manifest

const api = globalThis.browser ?? globalThis.chrome;
const { weblateStatus, pontoonStatus } = globalThis.TallyglotDetect;
const TTL = 6 * 3600000;

async function cached(key, ttl, load) {
  const store = await api.storage.local.get(key);
  const hit = store[key];
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await load();
  await api.storage.local.set({ [key]: { at: Date.now(), value } });
  return value;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** File paths of the default branch, or null when the forge will not say. */
async function repoFiles({ host, owner, repo }) {
  const path = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const url =
    host === 'github.com'
      ? `https://api.github.com/repos/${path}/git/trees/HEAD?recursive=1`
      : `https://codeberg.org/api/v1/repos/${path}/git/trees/HEAD?recursive=true&per_page=1000`;
  try {
    const body = await getJson(url);
    return (body.tree || []).map((f) => f.path).slice(0, 20000);
  } catch {
    return null;
  }
}

/** Coverage in `language`, or null when the platform cannot be asked. */
async function status({ platform, base, project }, language) {
  try {
    if (platform === 'weblate') {
      const rows = await getJson(`${base}/api/projects/${encodeURIComponent(project)}/languages/`);
      return weblateStatus(rows, language);
    }
    if (platform === 'pontoon') {
      const locale = String(language).replace(/_/g, '-');
      const body = await getJson(
        `${base}/api/v2/${encodeURIComponent(locale)}/${encodeURIComponent(project)}/`,
      );
      return pontoonStatus(body, language, project);
    }
  } catch (err) {
    // Not found on Pontoon means the locale has not been enabled for the project.
    if (platform === 'pontoon' && /HTTP 404/.test(err.message)) {
      return { started: false, percent: 0, left: null, url: null };
    }
  }
  return null; // Crowdin, Transifex and Lokalise answer only with a token
}

api.runtime.onMessage.addListener((message, sender, reply) => {
  const work =
    message.type === 'files'
      ? cached(`files:${message.repo.host}/${message.repo.owner}/${message.repo.repo}`, TTL, () =>
          repoFiles(message.repo),
        )
      : message.type === 'status'
        ? cached(
            `status:${message.found.platform}:${message.found.base || ''}:${message.found.project}:${message.language}`,
            TTL,
            () => status(message.found, message.language),
          )
        : Promise.resolve(null);
  work.then(reply, () => reply(null));
  return true; // the answer comes later
});
