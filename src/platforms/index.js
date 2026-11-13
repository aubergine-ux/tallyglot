// The platform registry. Adding a platform takes a module that implements the
// adapter interface described in ./shared.js, a line here, and a line in
// PLATFORM_META (../presets.js).

import { crowdin } from './crowdin.js';
import { lokalise } from './lokalise.js';
import { pontoon } from './pontoon.js';
import { transifex } from './transifex.js';
import { weblate } from './weblate.js';

export const PLATFORMS = { weblate, pontoon, crowdin, transifex, lokalise };

export const getPlatform = (id) => PLATFORMS[id] || weblate;

/** Client for an instance, built by the adapter of its platform. */
export function clientFor(instance, opts = {}) {
  return getPlatform(instance.platform).createClient({ baseUrl: instance.url, ...opts });
}

/** Refresh one instance through its adapter. Same result shape for every platform. */
export function refreshPlatform(client, instance, opts) {
  return getPlatform(instance.platform).refresh(client, instance, opts);
}
