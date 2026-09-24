/*
 * #655 pointer-path render probe. Streams an object-valued position and attitude with their
 * `meta.properties`, renders numeric widgets on `path#/field` pointer paths, and screenshots the
 * grid, so the resolved field values and units can be checked in the real bundle.
 *
 *   node shot-pointer.mjs --public ../public
 *
 * Expected tiles: latitude 60° 05.15′ N, roll -2.20 °, roll -0.0384 (no stored unit, so Signal K's
 * radians) and pitch 0.52 °. A second pass opens a widget's settings and types "latitude" into the
 * path picker, which should offer `self.navigation.position#/latitude` described as "Latitude".
 * Writes results/shots/pointer/{pointer-grid,pointer-picker}.png.
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './lib/server.mjs';
import { numericWidget, buildDashboards, localStorageBundle, serverConfigDocument, initScriptContent } from './lib/skip-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };

const publicDir = arg('public', join(HERE, '..', 'public'));
const port = Number(arg('port', '4425'));
const VIEWPORT = { width: 1290, height: 900 };

const POSITION = { latitude: 60.0859, longitude: 21.9767 };
const ATTITUDE = { roll: -0.0384, pitch: 0.0091, yaw: null };

const server = await startServer({ publicDir, base: '/@halos-org/skip/', port });
server.setConfigDocument(serverConfigDocument({
  dashboards: buildDashboards([
    numericWidget({ path: 'self.navigation.position#/latitude', unit: 'latitudeMin', displayName: 'lat (min)', numDecimal: 3 }),
    numericWidget({ path: 'self.navigation.attitude#/roll', unit: 'deg', displayName: 'roll (deg)', numDecimal: 2 }),
    numericWidget({ path: 'self.navigation.attitude#/roll', unit: 'unitless', displayName: 'roll (SI)', numDecimal: 4 }),
    numericWidget({ path: 'self.navigation.attitude#/pitch', unit: 'deg', displayName: 'pitch (deg)', numDecimal: 2 }),
  ]),
}));
server.setControl({
  streaming: true, rateHz: 2,
  selfPaths: ['navigation.position', 'navigation.attitude'],
  selfValues: { 'navigation.position': POSITION, 'navigation.attitude': ATTITUDE },
  selfMeta: {
    'navigation.position': { description: 'Position', properties: {
      latitude: { type: 'number', units: 'deg', description: 'Latitude' },
      longitude: { type: 'number', units: 'deg', description: 'Longitude' },
      altitude: { type: 'number', units: 'm', description: 'Altitude' } } },
    'navigation.attitude': { description: 'Attitude', properties: {
      roll: { type: 'number', units: 'rad', description: 'Vessel roll' },
      pitch: { type: 'number', units: 'rad', description: 'Pitch' },
      yaw: { type: 'number', units: 'rad', description: 'Yaw' } } },
  },
});

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const outDir = join(HERE, 'results', 'shots', 'pointer');
await mkdir(outDir, { recursive: true });

const bundle = localStorageBundle({ origin: server.origin, subscribeAll: false });
const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
await ctx.addInitScript({ content: initScriptContent(bundle) });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('about:blank');
await page.goto(`${server.appUrl}#/page/0`, { waitUntil: 'load', timeout: 30000 });
await page.waitForSelector('widget-numeric', { timeout: 20000 });
await page.waitForTimeout(3000); // several delta ticks, so every tile shows a live value
const count = await page.evaluate(() => document.querySelectorAll('widget-numeric').length);
await page.screenshot({ path: join(outDir, 'pointer-grid.png'), fullPage: true });
await ctx.close();

// Phase 2: the widget settings dialog's path picker, filtered by "latitude", should list the
// position field entry. The dashboard boots locked: enter edit mode, tap the widget, pick Settings.
server.setConfigDocument(serverConfigDocument({
  dashboards: buildDashboards([numericWidget({ path: null, unit: 'unitless', displayName: 'picker' })]),
}));
const ctx2 = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
await ctx2.addInitScript({ content: initScriptContent(bundle) });
const page2 = await ctx2.newPage();
page2.on('pageerror', e => errors.push(String(e)));
await page2.goto('about:blank');
await page2.goto(`${server.appUrl}#/page/0`, { waitUntil: 'load', timeout: 30000 });
await page2.waitForSelector('widget-numeric', { timeout: 20000 });
await page2.locator('button:has(mat-icon:text-is("lock_open"))').click();
await page2.locator('widget-host2 mat-card').first().click();
await page2.getByText('Settings', { exact: true }).click();
await page2.waitForSelector('mat-dialog-container', { timeout: 20000 });
await page2.waitForTimeout(2000); // meta and values arrive, so the picker's list is populated
await page2.getByRole('tab', { name: /paths/i }).click();
const pathInput = page2.locator('mat-dialog-container input[formcontrolname="path"]').first();
await pathInput.click();
await pathInput.fill('latitude');
await page2.waitForTimeout(800);
const options = await page2.locator('mat-option').allInnerTexts();
await page2.screenshot({ path: join(outDir, 'pointer-picker.png') });
await ctx2.close();
await browser.close();
await server.stop();

console.log(`${count} numeric widgets rendered -> ${join(outDir, 'pointer-grid.png')}`);
console.log(`picker options for "latitude": ${JSON.stringify(options)} -> ${join(outDir, 'pointer-picker.png')}`);
console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors');
