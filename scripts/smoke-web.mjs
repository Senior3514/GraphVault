#!/usr/bin/env node
/**
 * Headless smoke test for the web static export.
 *
 * Why this exists: unit tests and `build:web` both pass even when the app
 * throws a client-side exception on load (e.g. a hydration mismatch or a stale
 * service-worker chunk). Those bugs only show up when the built app is actually
 * loaded in a browser - which is exactly what shipped a production white-screen.
 * This script serves `apps/web/out` and loads every exported route in real
 * headless Chromium, failing (exit 1) on ANY uncaught page error.
 *
 * Run it AFTER `pnpm run build:web`:
 *   node scripts/smoke-web.mjs
 *
 * Chromium: resolved by Playwright automatically (PLAYWRIGHT_BROWSERS_PATH).
 * Override with GV_SMOKE_CHROMIUM=/path/to/chrome if needed. If no browser is
 * available the script SKIPS with a clear message rather than failing the build,
 * so it never blocks environments without a browser.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'apps/web/out');
const LOCALE = process.env.GV_SMOKE_LOCALE || 'he-IL';
const TZ = process.env.GV_SMOKE_TZ || 'Asia/Jerusalem';

if (!fs.existsSync(path.join(OUT, 'index.html'))) {
  console.error('smoke: apps/web/out is missing - run `pnpm run build:web` first.');
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.warn('smoke: playwright-core not installed - skipping browser smoke test.');
  process.exit(0);
}

// Enumerate routes from the export: every directory containing index.html.
function routes() {
  const found = new Set(['/']);
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name === '_next' || e.name.startsWith('.')) continue;
        const childRel = `${rel}${e.name}/`;
        if (fs.existsSync(path.join(dir, e.name, 'index.html'))) found.add(childRel);
        walk(path.join(dir, e.name), childRel);
      }
    }
  };
  walk(OUT, '/');
  return [...found].sort();
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
};

function resolveFile(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(OUT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  if (fs.existsSync(f + '.html')) return f + '.html';
  const idx = path.join(OUT, p, 'index.html');
  if (fs.existsSync(idx)) return idx;
  return null;
}

const server = http.createServer((req, res) => {
  const f = resolveFile(req.url);
  if (!f) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.GV_SMOKE_CHROMIUM || undefined,
    args: ['--no-sandbox'],
  });
} catch (e) {
  console.warn('smoke: could not launch Chromium - skipping. (' + String(e).split('\n')[0] + ')');
  server.close();
  process.exit(0);
}

const list = routes();
let failures = 0;

// A FRESH browser context per route - not one shared context for all routes.
// A shared context previously masked a real, reproducible React hydration
// crash (error #418) on /vault: visiting any other route first happened to
// leave the later /vault load clean, while a genuinely fresh visitor landing
// on /vault directly (a bookmark, a deep link, the very first page of a
// session) hit the crash every time. Testing each route as its own "first
// load ever" is what this smoke test exists for - see docs/agent-company/lessons.md.
for (const route of list) {
  const ctx = await browser.newContext({ locale: LOCALE, timezoneId: TZ });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.stack ? e.stack.split('\n')[0] : e)));
  try {
    await page.goto(base + route, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (e) {
    errors.push('navigation failed: ' + String(e).split('\n')[0]);
  }
  await page.waitForTimeout(1200);
  if (errors.length) {
    failures++;
    console.error(`✗ ${route}\n    ${errors.join('\n    ')}`);
  } else {
    console.log(`✓ ${route}`);
  }
  await page.close();
  await ctx.close();
}

await browser.close();
server.close();

if (failures) {
  console.error(`\nsmoke: ${failures}/${list.length} route(s) threw a client-side error.`);
  process.exit(1);
}
console.log(`\nsmoke: all ${list.length} routes loaded clean.`);
