// Opens the running HUD in a headless browser, visits the main screens, reports console errors and
// saves screenshots. Usage: node scripts/smoke-hud.mjs [outDir] [/#/route ...]
import path from 'node:path';
import { chromium } from 'playwright';

const auth = await import('../service/auth.js');
const token = auth.createSession('smoke-hud');
const H = { Authorization: `Bearer ${token}`, 'X-Jarvis': '1', 'Content-Type': 'application/json' };
const B = `http://127.0.0.1:${process.env.JARVIS_PORT || 7777}`;
const outDir = process.argv[2] || path.join(process.env.TEMP || '.', 'jarvis-smoke');
const settings = await (await fetch(`${B}/api/settings`, { headers: H })).json();
const errors = [];
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addCookies([{ name: 'jarvis_session', value: token, domain: '127.0.0.1', path: '/' }]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 200)}`));
  await fetch(`${B}/api/settings`, { method: 'PUT', headers: H, body: JSON.stringify({ core: 'face' }) });
  const shots =
    process.argv.length > 3
      ? process.argv.slice(3).map((r) => [r.replace(/^\/#\//, '').replace(/[^a-z0-9]+/gi, '-') || 'home', r])
      : [
          ['home-face', '/#/'],
          ['outbox', '/#/approvals'],
          ['settings-whatsapp', '/#/settings/whatsapp'],
          ['map', '/#/map'],
          ['flow', '/#/flow'],
        ];
  for (const [name, route] of shots) {
    await page.goto(`${B}${route}`);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
    console.log(`shot: ${path.join(outDir, `${name}.png`)}`);
  }
  // the command overlay with the face
  await page.goto(`${B}/#/`);
  await page.waitForTimeout(1500);
  await page.keyboard.press('Control+Space');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, 'overlay.png') });
  console.log(`shot: ${path.join(outDir, 'overlay.png')}`);
} finally {
  await browser.close();
  await fetch(`${B}/api/settings`, { method: 'PUT', headers: H, body: JSON.stringify({ core: settings.core }) });
  await fetch(`${B}/api/logout`, { method: 'POST', headers: H });
}
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors');
