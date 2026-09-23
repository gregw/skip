import { createRequire } from 'node:module';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { beforeAll, describe, expect, it } from 'vitest';
import { Polar, PolarState, PolarTable, toCanonicalPolarTable } from './polar-engine.util';
import hurmaPolar from './polar-engine.hurma-polar.fixture.json';

// polar-math is the reference implementation this engine ports. It is loaded through Node's
// require so the spec bundle never pulls it (or its ajv dependency) through the app build.
interface OracleResult<T> { value: T | null; state: PolarState }
interface OracleTargets { maxSpeed: { twa: number; speed: number } }
interface OraclePolar {
  speedAt(query: object): OracleResult<number>;
  rangeAt(query: object): OracleResult<{ minTwa: number; maxTwa: number }>;
  targetsAt(query: object): OracleResult<OracleTargets>;
}
interface PolarMathModule { Polar: { fromTable(table: unknown): OraclePolar } }
interface PolarFormatModule {
  toCanonicalPolarTable(data: unknown): { valid: boolean; value?: PolarTable; errors: { path: string; message: string }[] };
}

const projectRequire = createRequire(join(cwd(), 'package.json'));
const polarMath = projectRequire('polar-math') as PolarMathModule;
// Resolve polar-format as polar-math itself does, independent of how npm hoists it.
const polarFormat = createRequire(projectRequire.resolve('polar-math'))('polar-format') as PolarFormatModule;

const TOLERANCE = 1e-9;
const DEG = Math.PI / 180;

interface LooseTable {
  [key: string]: unknown;
  units?: Record<string, unknown>;
  symmetry?: Record<string, unknown>;
  axes: { tws?: unknown[]; twa?: unknown[] };
  values?: { boatSpeedMatrix: unknown[][] };
  derived?: { rows: Record<string, unknown>[] };
}

/** Knots and degrees, with zero cells, an all-zero row, derived targets and a last TWA below 180°. */
function knotsSource(): LooseTable {
  return {
    kind: 'polarTable',
    schemaVersion: '1.0.0',
    units: { tws: 'kn', twa: 'deg', boatSpeed: 'kn' },
    symmetry: { portStarboardSymmetric: true },
    axes: { tws: [6, 10, 16, 20, 25], twa: [32, 45, 60, 90, 120, 150] },
    values: {
      boatSpeedMatrix: [
        [0, 4.8, 5.6, 6.2, 5.8, 4.6],
        [4.2, 6.4, 7.0, 7.4, 7.2, 6.3],
        [5.0, 7.0, 7.6, 8.1, 8.4, 7.9],
        [0, 0, 7.8, 8.4, 8.9, 8.6],
        [0, 0, 0, 0, 0, 0]
      ]
    },
    derived: {
      rows: [
        { tws: 6, beat: { twa: 40, tbs: 4.5, vmg: 3.45 } },
        { tws: 10, run: { twa: 140, tbs: 6.6, vmg: 5.06 }, maxSpeed: 7.4, maxSpeedAngle: 90 },
        { tws: 16, beat: { twa: 38, tbs: 7.2, vmg: 5.67 }, run: null }
      ]
    }
  };
}

function matrixOf(table: LooseTable): unknown[][] {
  if (!table.values) throw new Error('table has no values');
  return table.values.boatSpeedMatrix;
}

function siSource(tws: number[], twaDeg: number[], matrix: number[][]): LooseTable {
  return {
    kind: 'polarTable',
    schemaVersion: '1.0.0',
    units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' },
    symmetry: { portStarboardSymmetric: true },
    axes: { tws, twa: twaDeg.map(value => value * DEG) },
    values: { boatSpeedMatrix: matrix }
  };
}

const singleColumnSource = (): LooseTable => siSource([4], [40, 60, 90, 120, 150, 180], [[2.6, 3.0, 3.2, 3.1, 2.7, 2.2]]);
const runOnlySource = (): LooseTable => siSource([3, 6], [100, 130, 160], [[2.0, 1.8, 1.4], [3.1, 3.0, 2.6]]);
const allZeroSource = (): LooseTable => siSource([3, 6], [45, 90], [[0, 0], [0, 0]]);

function load(source: unknown): { ours: Polar; oracle: OraclePolar; table: PolarTable } {
  const result = toCanonicalPolarTable(source);
  if (!result.ok) throw new Error(`fixture rejected: ${result.reason}`);
  const canonical = polarFormat.toCanonicalPolarTable(source);
  if (!canonical.valid) throw new Error(`oracle rejected fixture: ${JSON.stringify(canonical.errors)}`);
  return { ours: new Polar(result.table), oracle: polarMath.Polar.fromTable(canonical.value), table: result.table };
}

/** polar-format 1.0.0 throws, rather than failing validation, on a table without `values`. */
function oracleAccepts(source: unknown): boolean {
  try {
    return polarFormat.toCanonicalPolarTable(source).valid;
  } catch {
    return false;
  }
}

function canonicalFixture(): PolarTable {
  const result = toCanonicalPolarTable(hurmaPolar);
  if (!result.ok) throw new Error(`fixture rejected: ${result.reason}`);
  return result.table;
}

const TWA_MAGNITUDES = [
  0, 0.2, 25 * DEG, 0.55, 0.6, 0.62, 0.64, 0.65, 0.66, 0.68, 0.698131701, 0.75, 1, 1.2, Math.PI / 2,
  1.8, 2.2, 2.4, 2.6, 140 * DEG, 150 * DEG, 2.7, 2.9, 3.0, 3.1, Math.PI
];
const TWA_SWEEP = Array.from({ length: 316 }, (_, index) => index * 0.01);
const TWA_VALUES = [
  ...TWA_MAGNITUDES, ...TWA_MAGNITUDES.map(value => -value), ...TWA_SWEEP, 3.2, -3.2, NaN, Infinity
];
const TWS_BASE = [-1, 0, 0.00005, 0.0001, 0.5, 1, 2, 2.8, 3.5, 4, 5, 7.5, 9.5, 12, 30, NaN];
const FACTORS = [undefined, 1, 0.8, 0, -0.5, NaN];
const EXTRAPOLATE = [undefined, true, false];

function twsGrid(table: PolarTable): number[] {
  const axis = table.axes.tws;
  const midpoints = axis.slice(1).map((value, index) => (value + axis[index]) / 2);
  return [...TWS_BASE, ...axis, ...midpoints];
}

function sameState(a: PolarState, b: PolarState): boolean {
  return a.available === b.available && a.tws === b.tws && a.twa === b.twa &&
    (a.available || b.available || a.reason === b.reason);
}

function sameValue(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= TOLERANCE;
}

function speedMismatches(ours: Polar, oracle: OraclePolar, table: PolarTable): string[] {
  const failures: string[] = [];
  for (const tws of twsGrid(table)) {
    for (const twa of TWA_VALUES) {
      for (const performanceFactor of FACTORS) {
        for (const extrapolate of EXTRAPOLATE) {
          const query = { tws, twa, performanceFactor, extrapolate };
          const actual = ours.speedAt(query);
          const expected = oracle.speedAt(query);
          if (!sameValue(actual.value, expected.value) || !sameState(actual.state, expected.state)) {
            failures.push(`${JSON.stringify(query)}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
          }
        }
      }
    }
  }
  return failures.slice(0, 10);
}

function rangeMismatches(ours: Polar, oracle: OraclePolar, table: PolarTable): string[] {
  const failures: string[] = [];
  for (const tws of twsGrid(table)) {
    for (const performanceFactor of FACTORS) {
      for (const extrapolate of EXTRAPOLATE) {
        const query = { tws, performanceFactor, extrapolate };
        const actual = ours.rangeAt(query);
        const expected = oracle.rangeAt(query);
        const valuesMatch = actual.value === null || expected.value === null
          ? actual.value === expected.value
          : sameValue(actual.value.minTwa, expected.value.minTwa) && sameValue(actual.value.maxTwa, expected.value.maxTwa);
        if (!valuesMatch || !sameState(actual.state, expected.state)) {
          failures.push(`${JSON.stringify(query)}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
        }
      }
    }
  }
  return failures.slice(0, 10);
}

/** The oracle's peak: the largest max-speed target over every TWS column, at factor 1. */
function oraclePeak(oracle: OraclePolar, table: PolarTable): number | null {
  const speeds = table.axes.tws
    .map(tws => oracle.targetsAt({ tws }).value?.maxSpeed.speed)
    .filter((speed): speed is number => speed !== undefined);
  return speeds.length === 0 ? null : Math.max(...speeds);
}

const PARITY_TABLES: { label: string; source: () => unknown }[] = [
  { label: 'the test-server fixture', source: () => hurmaPolar },
  { label: 'a knots/degrees table with zero cells and derived targets', source: knotsSource },
  { label: 'a single-column table', source: singleColumnSource },
  { label: 'a table with no beat side', source: runOnlySource },
  { label: 'a table with only zero speeds', source: allZeroSource }
];

describe('polar-engine.util', () => {
  describe.each(PARITY_TABLES)('parity with polar-math 1.1.1 for $label', ({ source }) => {
    it('matches speedAt over the TWS, TWA, factor and extrapolation grid', () => {
      const { ours, oracle, table } = load(source());
      expect(speedMismatches(ours, oracle, table)).toEqual([]);
    });

    it('matches rangeAt over the TWS, factor and extrapolation grid', () => {
      const { ours, oracle, table } = load(source());
      expect(rangeMismatches(ours, oracle, table)).toEqual([]);
    });

    it('matches the peak speed across all TWS columns', () => {
      const { ours, oracle, table } = load(source());
      const expected = oraclePeak(oracle, table);
      const actual = ours.peakSpeed();
      if (expected === null) expect(actual).toBeNull();
      else expect(actual).toBeCloseTo(expected, 9);
    });

    it('never returns a factor-1 speed above the peak speed', () => {
      const { ours, table } = load(source());
      const peak = ours.peakSpeed() ?? 0;
      for (const tws of twsGrid(table)) {
        for (const twa of TWA_SWEEP) {
          const speed = ours.speedAt({ tws, twa }).value;
          if (speed !== null) expect(speed).toBeLessThanOrEqual(peak + TOLERANCE);
        }
      }
    });
  });

  describe('fixture behavior the overlay relies on', () => {
    let ours: Polar;
    beforeAll(() => {
      ours = new Polar(canonicalFixture());
    });

    it('scales speed toward zero below the lowest TWS column', () => {
      const atColumn = ours.speedAt({ tws: 2.5722, twa: Math.PI / 2 }).value;
      const half = ours.speedAt({ tws: 2.5722 / 2, twa: Math.PI / 2 }).value;
      expect(atColumn).not.toBeNull();
      expect(half).toBeCloseTo((atColumn ?? 0) / 2, 3);
    });

    it('clamps speed to the highest TWS column above the table', () => {
      expect(ours.speedAt({ tws: 30, twa: 1.5 }).value).toBe(ours.speedAt({ tws: 9.26, twa: 1.5 }).value);
    });

    it('mirrors negative TWA onto the positive side', () => {
      expect(ours.speedAt({ tws: 5, twa: -1.2 })).toEqual(ours.speedAt({ tws: 5, twa: 1.2 }));
    });

    it('scales speed by the performance factor', () => {
      const full = ours.speedAt({ tws: 5, twa: 1.2 }).value ?? 0;
      expect(ours.speedAt({ tws: 5, twa: 1.2, performanceFactor: 0.8 }).value).toBeCloseTo(full * 0.8, 12);
    });

    it('reports in irons and pinching below the beat angle', () => {
      expect(ours.speedAt({ tws: 5, twa: 0.5 })).toEqual({
        value: null,
        state: { available: true, tws: 'in_range', twa: 'in_irons' }
      });
      expect(ours.speedAt({ tws: 5, twa: 0.66 }).state.twa).toBe('pinching');
    });
  });

  describe('toCanonicalPolarTable', () => {
    it('converts a knots and degrees table to the same SI table as polar-format', () => {
      const actual = toCanonicalPolarTable(knotsSource());
      const expected = polarFormat.toCanonicalPolarTable(knotsSource());
      expect(expected.valid).toBe(true);
      expect(actual.ok).toBe(true);
      if (!actual.ok || !expected.value) return;
      expect(actual.table.units).toEqual({ tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' });
      expect(actual.table.axes).toEqual(expected.value.axes);
      expect(actual.table.values).toEqual(expected.value.values);
      expect(actual.table.derived?.rows?.map(row => ({ tws: row.tws, beat: row.beat, run: row.run })))
        .toEqual(expected.value.derived?.rows?.map(row => ({ tws: row.tws, beat: row.beat, run: row.run })));
    });

    it('leaves an SI table numerically unchanged', () => {
      const result = toCanonicalPolarTable(hurmaPolar);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.table.axes).toEqual(hurmaPolar.axes);
      expect(result.table.values).toEqual(hurmaPolar.values);
    });

    it('accepts unknown extra top-level fields', () => {
      expect(toCanonicalPolarTable({ ...hurmaPolar, id: 'x', timestamp: '2026-09-23T00:00:00Z', extra: { a: 1 } }).ok)
        .toBe(true);
    });

    it('accepts a table without schemaVersion, which the engine never reads', () => {
      const source = knotsSource();
      delete source['schemaVersion'];
      expect(toCanonicalPolarTable(source).ok).toBe(true);
    });

    const rejections: { label: string; mutate: (table: LooseTable) => void; path: string }[] = [
      { label: 'a missing TWA axis', mutate: table => { delete table.axes.twa; }, path: '/axes/twa' },
      { label: 'a missing TWS axis', mutate: table => { delete table.axes.tws; }, path: '/axes/tws' },
      { label: 'an empty TWS axis', mutate: table => { table.axes.tws = []; }, path: '/axes/tws' },
      { label: 'a zero TWS', mutate: table => { table.axes.tws = [0, 10, 16, 20, 25]; }, path: '/axes/tws/0' },
      { label: 'a non-increasing TWA axis', mutate: table => { table.axes.twa = [32, 45, 45, 90, 120, 150]; }, path: '/axes/twa/2' },
      { label: 'a TWA beyond 180 degrees', mutate: table => { table.axes.twa = [32, 45, 60, 90, 120, 190]; }, path: '/axes/twa/5' },
      { label: 'a missing matrix row', mutate: table => { matrixOf(table).pop(); }, path: '/values/boatSpeedMatrix' },
      { label: 'a short matrix row', mutate: table => { matrixOf(table)[1].pop(); }, path: '/values/boatSpeedMatrix/1' },
      { label: 'a non-array matrix row', mutate: table => { matrixOf(table)[1] = 'x' as unknown as unknown[]; }, path: '/values/boatSpeedMatrix/1' },
      { label: 'a negative speed', mutate: table => { matrixOf(table)[2][3] = -1; }, path: '/values/boatSpeedMatrix/2/3' },
      { label: 'a non-numeric speed', mutate: table => { matrixOf(table)[2][3] = '7'; }, path: '/values/boatSpeedMatrix/2/3' },
      { label: 'a missing values object', mutate: table => { delete table.values; }, path: '/values/boatSpeedMatrix' },
      { label: 'an unsupported TWS unit', mutate: table => { table.units = { ...table.units, tws: 'mph' }; }, path: '/units/tws' },
      { label: 'an unsupported TWA unit', mutate: table => { table.units = { ...table.units, twa: 'grad' }; }, path: '/units/twa' },
      { label: 'an unsupported boat speed unit', mutate: table => { table.units = { ...table.units, boatSpeed: 'km/h' }; }, path: '/units/boatSpeed' },
      { label: 'missing units', mutate: table => { delete table.units; }, path: '/units' },
      { label: 'an asymmetric table', mutate: table => { table.symmetry = { portStarboardSymmetric: false }; }, path: '/symmetry/portStarboardSymmetric' },
      { label: 'a missing symmetry flag', mutate: table => { delete table.symmetry; }, path: '/symmetry/portStarboardSymmetric' },
      { label: 'the wrong kind', mutate: table => { table['kind'] = 'polarCurve'; }, path: '/kind' },
      { label: 'a derived target without a TWA', mutate: table => { table.derived = { rows: [{ tws: 6, beat: { tbs: 4.5 } }] }; }, path: '/derived/rows/0/beat' },
      { label: 'a derived row without a TWS', mutate: table => { table.derived = { rows: [{ beat: null }] }; }, path: '/derived/rows/0/tws' },
    ];

    it.each(rejections)('rejects $label with a reason, as polar-format does', ({ mutate, path }) => {
      const source = knotsSource();
      mutate(source);
      const result = toCanonicalPolarTable(source);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain(path);
      expect(oracleAccepts(source)).toBe(false);
    });

    it.each([null, undefined, 'polar', 42, [hurmaPolar]])('rejects the non-object %j', value => {
      const result = toCanonicalPolarTable(value);
      expect(result.ok).toBe(false);
    });
  });
});
