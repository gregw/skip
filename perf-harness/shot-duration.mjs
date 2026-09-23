/*
 * #627 duration render probe. Streams `navigation.racing.timeToStart` at 1800 s with the meta the
 * Signal K server sends when the time category (or a per-path override) targets `HH:MM:SS`, and
 * screenshots a numeric tile (min/max shown), a steel gauge and a linear gauge reading it.
 *
 *   CHROME_BIN=/usr/bin/chromium node shot-duration.mjs --public ../public [--out duration]
 *
 * Expect the numeric tile to read `30:00` with no unit label and its min row formatted the same;
 * the gauges keep a numeric scale and read 1800 in seconds. The second page repeats the path with
 * the built-in presets' `hour` target, which stays a decimal `0.5`.
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './lib/server.mjs';
import { buildDashboards, localStorageBundle, serverConfigDocument, initScriptContent, numericWidget, steelGaugeWidget, simpleLinearWidget } from './lib/skip-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };

const publicDir = arg('public', join(HERE, '..', 'public'));
const port = Number(arg('port', '4432'));
const VIEWPORT = { width: 1290, height: 640 };

const PATH = 'navigation.racing.timeToStart';
const SELF_PATH = `self.${PATH}`;
const SECONDS = 1800;

const withMinMax = factory => (x, y) => {
  const n = factory(x, y);
  Object.assign(n.input.widgetProperties.config, { showMin: true, showMax: true });
  return n;
};
const tile = { path: SELF_PATH, displayName: 'Time to start', unit: 'unitless', scale: { lower: 0, upper: 3600 } };
const tiles = () => [
  withMinMax(numericWidget({ ...tile, h: 8, ignoreZones: true })),
  steelGaugeWidget(tile),
  simpleLinearWidget(tile),
];

const server = await startServer({ publicDir, base: '/@halos-org/skip/', port });
const pages = buildDashboards(tiles()).concat(buildDashboards(tiles()));
pages[0].name = 'Clock';
pages[1].name = 'Hours';
server.setConfigDocument(serverConfigDocument({ dashboards: pages }));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const outDir = join(HERE, 'results', 'shots', arg('out', 'duration'));
await mkdir(outDir, { recursive: true });

const bundle = localStorageBundle({ origin: server.origin, subscribeAll: false });
const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
await ctx.addInitScript({ content: initScriptContent(bundle) });
const page = await ctx.newPage();

const timeMeta = targetUnit => ({
  [PATH]: { units: 's', description: 'Time to start', displayUnits: { category: 'time', targetUnit } },
});

async function shoot(name, pageIndex, meta) {
  server.setControl({ streaming: true, rateHz: 4, selfPaths: [PATH], selfValues: { [PATH]: SECONDS }, selfMeta: meta });
  await page.goto('about:blank');
  await page.goto(`${server.appUrl}#/page/${pageIndex}`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('widget-gauge-steel', { timeout: 20000 });
  await page.waitForTimeout(2500); // canvases draw, then meta + a few value frames land
  const count = await page.evaluate(() => document.querySelectorAll('widget-host2').length);
  await page.screenshot({ path: join(outDir, `${name}.png`), fullPage: false });
  if (count !== 3) { console.error(`boot check failed: ${count} tiles rendered, expected 3`); process.exit(1); }
}

await shoot('clock', 0, timeMeta('HH:MM:SS'));
await shoot('hours', 1, timeMeta('hour'));

await ctx.close();
await browser.close();
await server.stop();

console.log(`\n=== #627 duration (${SECONDS} s) ===`);
console.log('clock.png  expect the numeric tile to read 30:00 with no unit label; gauges read 1800');
console.log('hours.png  expect 0.5 on the numeric tile (the presets\' decimal hours)');
console.log(`-> ${outDir}`);
