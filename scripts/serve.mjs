#!/usr/bin/env node
// Local preview: node scripts/serve.mjs [port]   (default 8080, or the next free port)

import { startApp } from '../e2e/servers.mjs';

const wanted = Number(process.argv[2] || process.env.PORT || 8080);
let app;
try {
  app = await startApp({}, wanted);
} catch (err) {
  if (err.code !== 'EADDRINUSE') throw err;
  app = await startApp({}, 0);
  console.log(`Port ${wanted} is busy, using another one.`);
}
console.log(`Tallyglot is running at ${app.url}/  (demo: ${app.url}/?demo)\nPress Ctrl+C to stop.`);
