// Serves the season page locally with working "Fetch" buttons: they run fetch-data.mjs and
// build.mjs on this computer, then the page reloads with the new data. (The published page
// can't do this itself: the claude.ai viewer blocks calls to the Matchcentre.)
// Usage: node scripts/serve.mjs [seasonYear] [--port 5178]   (default 2026), then open the printed address.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = process.argv.slice(2);
const YEAR = ARGS.find(a => /^\d{4}$/.test(a)) || '2026';
const PORT = Number(ARGS[ARGS.indexOf('--port') + 1]) || 5178;
const PAGE = path.join(ROOT, 'dist', `vcc-season-facts-${YEAR}.local.html`);

// Runs a script and collects its output; rejects with that output when it fails.
function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { cwd: ROOT });
    let log = '';
    const add = chunk => { log += chunk; process.stdout.write(chunk); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.on('error', e => reject(Object.assign(e, { log })));
    child.on('close', code => (code === 0 ? resolve(log) : reject(Object.assign(new Error(`${script} exited with code ${code}`), { log }))));
  });
}

let busy = null; // one fetch at a time; a second click waits for the running one

async function fetchAndBuild(refresh) {
  const log = await run('fetch-data.mjs', [YEAR, ...(refresh ? ['--refresh'] : [])]);
  return log + await run('build.mjs', [YEAR]);
}

const send = (res, status, type, body) => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
};

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/#') || req.url.startsWith('/?'))) {
      let html;
      try { html = await fs.readFile(PAGE, 'utf8'); } catch {
        await run('build.mjs', [YEAR]);
        html = await fs.readFile(PAGE, 'utf8');
      }
      // Tells the page it is served from here, so it shows the fetch buttons.
      return send(res, 200, 'text/html; charset=utf-8', html.replace('<body>', '<body>\n<script>window.VCC_LOCAL = true;</script>'));
    }
    if (req.method === 'POST' && req.url === '/api/fetch') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const refresh = !!JSON.parse(body || '{}').refresh;
      console.log(`\n[${new Date().toLocaleTimeString()}] ${refresh ? 'Fetching everything again' : 'Fetching new results'}…`);
      busy = busy || fetchAndBuild(refresh).finally(() => { busy = null; });
      try {
        const log = await busy;
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, log: log.slice(-4000) }));
      } catch (e) {
        return send(res, 500, 'application/json', JSON.stringify({ ok: false, log: `${e.message}\n${(e.log || '').slice(-4000)}` }));
      }
    }
    send(res, 404, 'text/plain', 'Not found');
  } catch (e) {
    send(res, 500, 'text/plain', String(e && e.stack || e));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`VCC Season Facts ${YEAR}: http://localhost:${PORT}/  (Ctrl+C to stop)`);
});
