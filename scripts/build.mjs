// Builds the single-file page: src/index.html + src/stats.js + data/season-<year>.json
//   dist/vcc-season-facts-<year>.html   page body for publishing as an Artifact
//   dist/vcc-season-facts-<year>.local.html   same page with a full HTML shell, to open locally
//   dist/site/index.html   with --site <workflow url>: the GitHub Pages copy, linking to the refresh workflow
// Usage: node scripts/build.mjs [seasonYear] [--site <workflow url>]   (default 2026)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = process.argv.slice(2);
const year = ARGS.find(a => /^\d{4}$/.test(a)) || '2026';
const siteIdx = ARGS.indexOf('--site');
const site = siteIdx >= 0 ? ARGS[siteIdx + 1] : null;

const [tpl, stats, data] = await Promise.all([
  fs.readFile(path.join(ROOT, 'src', 'index.html'), 'utf8'),
  fs.readFile(path.join(ROOT, 'src', 'stats.js'), 'utf8'),
  fs.readFile(path.join(ROOT, 'data', `season-${year}.json`), 'utf8'),
]);

// Keep "</script>" inside the JSON from closing the script tag.
const safeData = data.replace(/<\/(script)/gi, '<\\/$1');
const page = tpl
  .replace('/*__STATS__*/', () => stats)
  .replace('/*__DATA__*/null', () => safeData)
  .replace(/VCC Season Facts 2026/g, `VCC Season Facts ${year}`);

await fs.mkdir(path.join(ROOT, 'dist'), { recursive: true });
const base = path.join(ROOT, 'dist', `vcc-season-facts-${year}`);
await fs.writeFile(`${base}.html`, page);
const shell = (head = '') =>
  `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">${head}</head><body>\n${page}\n</body></html>\n`;
await fs.writeFile(`${base}.local.html`, shell());
console.log(`Built ${path.relative(ROOT, base)}.html (${(page.length / 1024).toFixed(0)} KB) and .local.html`);

if (site) {
  await fs.mkdir(path.join(ROOT, 'dist', 'site'), { recursive: true });
  await fs.writeFile(path.join(ROOT, 'dist', 'site', 'index.html'),
    shell(`<script>window.VCC_SITE = ${JSON.stringify({ actions: site }).replace(/</g, '\\u003c')};</script>`));
  console.log('Built dist/site/index.html');
}
