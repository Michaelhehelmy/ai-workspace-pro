#!/usr/bin/env node
// UI smoke test for the AI Workspace Pro web app (index.html).
//
// Drives a real headless Chrome against the static dev server and asserts the
// boot, chat send/reply, and conversation-clear flows. Requires a local
// Chromium binary (uses the puppeteer-managed cache if present) and the
// workspace static server (python3 -m http.server 3000).
//
// Usage: node test-ui.mjs   (UI_URL defaults to http://localhost:3000/)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const URL = process.env.UI_URL || 'http://localhost:3000/';

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/home/michael/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ];
  const glob = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome', '*', 'chrome-linux64', 'chrome');
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  const matches = fs.existsSync(path.dirname(glob)) ? fs.readdirSync(path.dirname(glob)) : [];
  for (const m of matches) {
    const p = path.join(path.dirname(glob), m, 'chrome-linux64', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const CHROME = findChrome();
if (!CHROME) {
  console.error('✖ No Chromium binary found. Install one or set CHROME_PATH.');
  process.exit(1);
}

const failures = [];
const check = (cond, msg) => {
  if (cond) {
    console.log(`  ✔ ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  ✖ ${msg}`);
  }
};

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// A one-time GET /api/health probe detects whether the deployed Worker is
// present (it is the same-origin host for /api/web/* and /api/hub/* proxies).
// On bare static hosting that probe 404s by design; treat it as benign here.
const isHealthProbe404 = (text) =>
  /api\/health/.test(text) ||
  (/Failed to load resource/i.test(text) && /404/.test(text));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});

try {
  const page = await browser.newPage();
  page.on('pageerror', e => console.log(`  ⚠ pageerror: ${e.message}`));
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  const badResponses = [];
  page.on('response', res => {
    if (res.status() === 404) badResponses.push(res.url());
  });

  console.log(`\n🧪 UI smoke — ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // 1. Boot: the app must hydrate the header/identity from config.json.
  await page.waitForFunction(() => {
    const n = document.getElementById('current-name');
    return n && n.textContent.trim().length > 0;
  }, { timeout: 15000 });
  await wait(1200);

  const brand = await page.$eval('#appBrandName', e => e.textContent.trim());
  const currentName = await page.$eval('#current-name', e => e.textContent.trim());
  check(brand === currentName && brand.length > 0, `sidebar brand mirrors active character ("${brand}")`);

  const bizLabel = await page.$eval('#activeBizLabel', e => e.textContent.trim());
  check(bizLabel.length > 0, `active business label renders ("${bizLabel}")`);

  const persona = await page.$eval('#current-persona', e => e.textContent.trim());
  check(persona.length > 0, `current persona renders ("${persona}")`);

  // 2. Keep the smoke deterministic: disable on-device models post-boot so the
  // reply path degrades fast instead of attempting a model download.
  await page.evaluate(() => { window.__MODELS_DISABLED__ = true; });

  // 3. Send a message and wait for user + assistant bubbles.
  const msg = '🧪 smoke test message';
  await page.evaluate((m) => {
    const input = document.getElementById('chatInput');
    input.value = m;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, msg);
  await wait(300);
  await page.click('#sendBtn');

  await page.waitForFunction((m) => {
    const els = Array.from(document.querySelectorAll('.msg-row.from-user .msg-bubble'));
    return els.some(e => e.textContent.includes(m));
  }, { timeout: 10000 }, msg);
  check(true, `user bubble appears with sent text`);

  await page.waitForFunction(() => {
    const b = document.querySelector('.msg-row.from-bot .msg-bubble');
    if (!b) return false;
    const t = b.textContent.trim();
    return t.length > 0 && !t.includes('typing');
  }, { timeout: 30000 });
  const reply = await page.$eval('.msg-row.from-bot .msg-bubble', e => e.textContent.trim());
  check(reply.length > 0, `assistant replies (${reply.length} chars)`);

  // 4. Clear the conversation and confirm the message log empties.
  await page.click('#clearChatBtn');
  await wait(600);
  const remaining = await page.$$eval('#chatMessages .msg-row', els => els.length);
  check(remaining <= 1, `clearChatBtn empties the message log (${remaining} row(s) left, greeting only)`);

  const badConsole = consoleErrors.filter(t => !/favicon/i.test(t)).filter(t => !isHealthProbe404(t));
  check(badConsole.length === 0, `no console errors during smoke${badConsole.length ? ` — ${badConsole.join(' | ')}` : ''}`);
  const missingFavicon = badResponses.some(u => /\/favicon\.ico$/i.test(u));
  check(!missingFavicon, `no /favicon.ico 404 fallback (missingFavicon=${missingFavicon})`);
  const other404 = badResponses.filter(u => !/\/favicon\.ico$/i.test(u)).filter(u => !isHealthProbe404(u));
  check(other404.length === 0, `no unexpected 404 responses${other404.length ? ` — ${other404.join(' | ')}` : ''}`);
} finally {
  await browser.close();
}

if (failures.length) {
  console.log(`\n✖ UI SMOKE FAILED — ${failures.length} check(s) failed\n`);
  process.exit(1);
}
console.log('\n✔ UI SMOKE PASSED\n');