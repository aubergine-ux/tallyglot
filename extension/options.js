// Options and toolbar popup: the language whose status the panel shows.

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

for (const node of document.querySelectorAll('[data-msg]')) {
  node.textContent = api.i18n.getMessage(node.dataset.msg);
}

function showDashboard(url) {
  $('open').hidden = !/^https?:\/\//.test(url);
  if (!$('open').hidden) $('open').href = url;
}

api.storage.local.get(['language', 'dashboard']).then((store) => {
  $('language').value = store.language || '';
  $('dashboard').value = store.dashboard || '';
  showDashboard(store.dashboard || '');
});

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const language = $('language').value.trim();
  const dashboard = $('dashboard').value.trim();
  // Status answers were cached for the previous language: start clean.
  const all = await api.storage.local.get(null);
  await api.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('status:')));
  await api.storage.local.set({ language, dashboard });
  showDashboard(dashboard);
  $('saved').textContent = api.i18n.getMessage('optionsSaved');
  setTimeout(() => ($('saved').textContent = ''), 2000);
});
