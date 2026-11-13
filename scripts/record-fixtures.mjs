#!/usr/bin/env node
// Records API responses of the token-only platforms into test/fixtures, to
// replace the hand-written ones. Give it your own token and a project you
// can read; nothing else is sent anywhere.
//
//   CROWDIN_TOKEN=…   CROWDIN_PROJECT=<numeric id>            node scripts/record-fixtures.mjs
//   TRANSIFEX_TOKEN=… TRANSIFEX_PROJECT=<org>/<project> TRANSIFEX_LANGUAGE=pt_BR  node scripts/record-fixtures.mjs
//   LOKALISE_TOKEN=…  LOKALISE_PROJECT=<project id>           node scripts/record-fixtures.mjs
//
// Review the files before committing them: they hold project names and ids.
// The adapter tests assert on values of the current fixtures, so adjust the
// expectations in test/platforms.test.mjs to the recorded project.

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const env = process.env;

async function record(name, url, headers) {
  const res = await fetch(url, { headers: { Accept: 'application/json', ...headers } });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  await writeFile(join(dir, `${name}.json`), `${JSON.stringify(await res.json(), null, 1)}\n`);
  console.log(`recorded ${name}.json`);
}

let recorded = 0;
try {
  if (env.CROWDIN_TOKEN && env.CROWDIN_PROJECT) {
    const auth = { Authorization: `Bearer ${env.CROWDIN_TOKEN}` };
    const base = 'https://api.crowdin.com/api/v2';
    await record('crowdin-project', `${base}/projects/${env.CROWDIN_PROJECT}`, auth);
    await record('crowdin-projects', `${base}/projects?limit=500&offset=0`, auth);
    await record(
      'crowdin-progress',
      `${base}/projects/${env.CROWDIN_PROJECT}/languages/progress?limit=500&offset=0`,
      auth,
    );
    recorded += 1;
  }
  if (env.TRANSIFEX_TOKEN && env.TRANSIFEX_PROJECT) {
    const auth = {
      Authorization: `Bearer ${env.TRANSIFEX_TOKEN}`,
      Accept: 'application/vnd.api+json',
    };
    const base = 'https://rest.api.transifex.com';
    const [org, project] = env.TRANSIFEX_PROJECT.split('/');
    const id = `o:${org}:p:${project}`;
    const filter = `filter[project]=${encodeURIComponent(id)}`;
    await record('transifex-project', `${base}/projects/${id}`, auth);
    await record('transifex-resources', `${base}/resources?${filter}`, auth);
    await record(
      'transifex-stats-page1',
      `${base}/resource_language_stats?${filter}&filter[language]=l:${env.TRANSIFEX_LANGUAGE || 'pt_BR'}`,
      auth,
    );
    recorded += 1;
  }
  if (env.LOKALISE_TOKEN && env.LOKALISE_PROJECT) {
    await record(
      'lokalise-project',
      `https://api.lokalise.com/api2/projects/${env.LOKALISE_PROJECT}`,
      {
        'X-Api-Token': env.LOKALISE_TOKEN,
      },
    );
    recorded += 1;
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
if (!recorded) {
  console.log(
    'Nothing recorded: set a token and a project for at least one platform (see the top of this file).',
  );
}
