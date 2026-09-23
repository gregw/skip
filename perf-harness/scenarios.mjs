/*
 * Measurement scenarios. Each exercises a specific verified audit finding so the
 * before/after numbers map to a named root cause. Data profiles drive the mock
 * server; dashboards are built fresh per repeat (unique widget uuids).
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { numericWidget, radialGaugeWidget, aisRadarWidget, windsteerWidget, buildDashboards } from './lib/skip-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLAR_ID = 'hurma-measured-2024-2026';
const POLAR_TABLE = JSON.parse(await readFile(join(HERE, '..', 'src', 'app', 'core', 'utils', 'polar-engine.hurma-polar.fixture.json'), 'utf8'));
const ACTIVE_POLAR = { href: `/resources/polars/${POLAR_ID}` };
const rad = (deg) => deg * Math.PI / 180;
// A boat beating toward a waypoint 25° off the bow while heading, wind angle and speeds wander, so
// the VMC curve, its dot and the pointers all recompute continuously.
const WINDSTEER_VMC_VALUES = {
  'navigation.headingTrue': (t) => rad(30 + 10 * Math.sin(t / 1300)),
  'navigation.courseOverGroundTrue': (t) => rad(36 + 10 * Math.sin(t / 1300)),
  'navigation.speedOverGround': (t) => 3 + 0.3 * Math.sin(t / 900),
  'navigation.speedThroughWater': (t) => 3.1 + 0.3 * Math.sin(t / 700),
  'navigation.course.calcValues.bearingTrue': rad(55),
  'environment.wind.angleApparent': (t) => rad(35 + 6 * Math.sin(t / 1100)),
  'environment.wind.speedApparent': (t) => 8 + Math.sin(t / 1500),
  'environment.wind.angleTrueWater': (t) => rad(52 + 8 * Math.sin(t / 1100)),
  'environment.wind.speedTrue': (t) => 6 + 1.5 * Math.sin(t / 2100),
  'environment.current.drift': 0.4,
  'environment.current.setTrue': rad(120),
  'steering.rudderAngle': (t) => rad(8 * Math.sin(t / 800)),
  'polars.activePolar': ACTIVE_POLAR,
  'polars.performanceFactor': 1,
};

const POOL = [
  'navigation.speedOverGround', 'navigation.headingTrue', 'navigation.courseOverGroundTrue',
  'environment.depth.belowTransducer', 'environment.wind.angleApparent', 'environment.wind.speedApparent',
];

// Many extra paths to stress the delta parse + fan-out (widgets need not subscribe;
// data.service still upserts _skData and emits _pathUpdates$ for every path).
const manyPaths = (n) => [...POOL, ...Array.from({ length: Math.max(0, n - POOL.length) }, (_, i) => `sensors.mock.n${i}.value`)];

const numericGrid = (n) => buildDashboards(Array.from({ length: n }, (_, i) => numericWidget({ path: 'self.' + POOL[i % POOL.length], updateInterval: 500 })));
const gaugeGrid = (n) => buildDashboards(Array.from({ length: n }, (_, i) => radialGaugeWidget({ path: 'self.' + POOL[i % POOL.length], updateInterval: 500 })));

export const scenarios = [
  {
    label: 'idle-numeric-24',
    note: 'baseline render/CD load: 24 numeric widgets, low data rate (WS4 baseline)',
    subscribeAll: false, durationMs: 8000, warmupMs: 2000,
    dashboards: () => numericGrid(24),
    control: { rateHz: 2, selfPaths: POOL, ais: { count: 0, churnPerSec: 0 } },
  },
  {
    label: 'delta-storm-30x10',
    note: 'sustained ingestion: 30 paths @ 10Hz over a numeric+gauge dashboard (rank 2, delta coalescing)',
    subscribeAll: false, durationMs: 12000, warmupMs: 2000,
    dashboards: () => numericGrid(20),
    control: { rateHz: 10, selfPaths: manyPaths(30), ais: { count: 0, churnPerSec: 0 } },
  },
  {
    label: 'reconnect-backlog',
    note: 'reconnect snapshot: one frame carrying 6000 values (rank 2, single synchronous parse+fan-out long task)',
    subscribeAll: false, durationMs: 7000, warmupMs: 2000,
    dashboards: () => numericGrid(20),
    control: { rateHz: 4, selfPaths: manyPaths(20), ais: { count: 0, churnPerSec: 0 } },
    async action(page, server, durationMs) {
      await page.waitForTimeout(1000);
      server.blastBig(6000); // reconnect snapshot: one big frame => one long task
      await page.waitForTimeout(durationMs - 1000);
    },
  },
  {
    label: 'resize-storm',
    note: '28 canvas widgets + repeated viewport resizes: shared ResizeObserver reallocates every canvas in one task (rank 1, the fullscreen enter/exit storm)',
    subscribeAll: false, durationMs: 7000, warmupMs: 2500,
    dashboards: () => numericGrid(28),
    control: { rateHz: 2, selfPaths: POOL, ais: { count: 0, churnPerSec: 0 } },
    async action(page, server, durationMs) {
      const sizes = [[1600, 1000], [900, 1400], [1600, 1000], [1280, 800], [1920, 1080], [800, 1200], [1600, 1000], [1100, 900]];
      for (const [w, h] of sizes) { await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(500); }
      await page.waitForTimeout(Math.max(0, durationMs - sizes.length * 500));
    },
  },
  {
    label: 'ais-radar-150',
    note: '150 AIS targets @ 4Hz + streaming own-ship (ranks 4/5, radar render loops)',
    subscribeAll: true, durationMs: 12000, warmupMs: 3000,
    dashboards: () => buildDashboards([aisRadarWidget()]),
    control: { rateHz: 4, selfPaths: ['navigation.position', 'navigation.headingTrue', 'navigation.courseOverGroundTrue', 'navigation.speedOverGround'], ais: { count: 150, churnPerSec: 0 } },
  },
  {
    label: 'gauges-16',
    note: '16 radial ng-canvas-gauges @ 4Hz (rank 7, animation duty cycle)',
    subscribeAll: false, durationMs: 10000, warmupMs: 2000,
    dashboards: () => gaugeGrid(16),
    control: { rateHz: 4, selfPaths: POOL, ais: { count: 0, churnPerSec: 0 } },
  },
  {
    label: 'windsteer-vmc',
    note: 'one full-size Wind Steer with the polar overlay in VMC mode, heading/wind/STW wandering @ 10Hz (#478; a build without the overlay ignores the option)',
    subscribeAll: false, durationMs: 10000, warmupMs: 3000,
    dashboards: () => buildDashboards([windsteerWidget({ polarOverlayEnable: true })]),
    control: {
      rateHz: 10, selfPaths: Object.keys(WINDSTEER_VMC_VALUES), selfValues: WINDSTEER_VMC_VALUES,
      restSelfValues: { 'polars.activePolar': ACTIVE_POLAR }, resources: { [`polars/${POLAR_ID}`]: POLAR_TABLE },
      ais: { count: 0, churnPerSec: 0 },
    },
  },
  {
    label: 'ais-growth-churn',
    note: 'AIS radar with 40 targets + 40 new MMSIs/sec churn for 30s (ranks 8/9, heap growth)',
    subscribeAll: true, durationMs: 30000, warmupMs: 3000,
    dashboards: () => buildDashboards([aisRadarWidget()]),
    control: { rateHz: 5, selfPaths: ['navigation.position', 'navigation.headingTrue'], ais: { count: 40, churnPerSec: 40 } },
  },
];
