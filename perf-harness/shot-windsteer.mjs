/*
 * #637 Wind Steer current-readout render probe. Streams one fixed boat state (heading, apparent and
 * true wind, COG/SOG, waypoint bearing, hard-over rudder, and a 0.8 kn current setting 120°) and screenshots
 * the Wind Steer widget in compass mode at a large and a small tile, in the light, dark and night
 * themes, so before/after images are directly comparable.
 *
 *   node shot-windsteer.mjs --public ../public --label after
 *   node shot-windsteer.mjs --public /path/to/main/public --label before --out /tmp/shots
 *
 * Writes <out>/<label>-<theme>-<size>.png (default out: results/shots/windsteer). Expect the drift
 * value, its unit and the set arrow in the bottom-right corner, clear of the dial and the rudder
 * arcs, with the arrow pointing 90° right of the bow (set 120° at heading 030°).
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './lib/server.mjs';
import { appConfig, windsteerWidget, buildDashboards, localStorageBundle, serverConfigDocument, initScriptContent } from './lib/skip-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };

const publicDir = arg('public', join(HERE, '..', 'public'));
const label = arg('label', 'windsteer');
const outDir = arg('out', join(HERE, 'results', 'shots', 'windsteer'));
const port = Number(arg('port', '4432'));
// The dashboard grid is 24x24 over the viewport, so a 24-cell tile fills it and a 6-cell tile is ~220 px.
const VIEWPORT = { width: 900, height: 900 };
const SIZES = { large: 24, small: 6 };

const rad = (deg) => deg * Math.PI / 180;
const KN = 1852 / 3600; // m/s per knot
// Signal K carries SI; the knots preference arrives in meta, as a server with the nautical preset sends it.
const VALUES = {
  'navigation.headingTrue': rad(30),
  'navigation.courseOverGroundTrue': rad(38),
  'navigation.speedOverGround': 5.5 * KN,
  'navigation.course.calcValues.bearingTrue': rad(75),
  'environment.wind.angleApparent': rad(35),
  'environment.wind.speedApparent': 16 * KN,
  'environment.wind.angleTrueWater': rad(52),
  'environment.wind.speedTrue': 12 * KN,
  'environment.current.drift': 0.8 * KN,
  'environment.current.setTrue': rad(120),
  // Hard over to starboard: the arc reaches its end nearest the corner readout.
  'steering.rudderAngle': rad(35),
};
const knots = { units: 'm/s', displayUnits: { category: 'speed', targetUnit: 'kn', formula: 'value * 1.94384', inverseFormula: 'value / 1.94384', symbol: 'kn', displayFormat: '0.0' } };
const META = Object.fromEntries(Object.keys(VALUES).map((p) => [p, /speed|drift/i.test(p) ? knots : { units: 'rad' }]));

// Night is the red night theme, switched on by the server's environment.mode under auto night mode.
const THEMES = {
  light: { themeName: 'light-theme', app: appConfig(), mode: 'day' },
  dark: { themeName: '', app: appConfig(), mode: 'day' },
  night: { themeName: '', app: appConfig({ autoNightMode: true, redNightMode: true }), mode: 'night' },
};

const server = await startServer({ publicDir, base: '/@halos-org/skip/', port });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
await mkdir(outDir, { recursive: true });
const bundle = localStorageBundle({ origin: server.origin, subscribeAll: false });

let failed = 0;
for (const [theme, { themeName, app, mode }] of Object.entries(THEMES)) {
  const dashboards = Object.values(SIZES).flatMap((cells) => buildDashboards([windsteerWidget({ w: cells, h: cells })]));
  server.setConfigDocument(serverConfigDocument({ dashboards, app, themeName }));
  const values = { ...VALUES, 'environment.mode': mode };
  server.setControl({ streaming: true, rateHz: 4, selfPaths: Object.keys(values), selfValues: values, selfMeta: META });

  for (const [size, page] of Object.keys(SIZES).map((s, i) => [s, i])) {
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await ctx.addInitScript({ content: initScriptContent(bundle) });
    const tab = await ctx.newPage();
    await tab.goto(`${server.appUrl}?embed=1#/page/${page}`, { waitUntil: 'load', timeout: 30000 });
    await tab.waitForSelector('widget-wind-steer', { timeout: 20000 });
    await tab.waitForTimeout(3000); // meta and several value frames land, needles finish animating
    const count = await tab.evaluate(() => document.querySelectorAll('widget-wind-steer').length);
    const file = join(outDir, `${label}-${theme}-${size}.png`);
    await tab.locator('widget-wind-steer').screenshot({ path: file });
    console.log(`[shot] ${file}`);
    if (count !== 1) { console.error(`boot check failed: ${count} windsteer widgets rendered, expected 1`); failed++; }
    await ctx.close();
  }
}

await browser.close();
await server.stop();
if (failed) process.exit(1);
