/*
 * Polar table engine: unit canonicalization, validation and speed interpolation for Signal K
 * polar tables (`kind: "polarTable"`, as served by the v2 Resources API).
 *
 * Ported to TypeScript from two packages by Aswin Bouwmeester (github.com/Asw1n), both licensed
 * under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0):
 *   - polar-math 1.1.1 (https://github.com/Asw1n/polar-math): table preparation, speedAt, rangeAt,
 *     targetsAt and the per-TWS maximum speed.
 *   - polar-format 1.0.0 (https://github.com/Asw1n/polar-format): unit canonicalization.
 * Neither package ships a NOTICE file.
 *
 * Changes from the originals: rewritten in TypeScript; vmgAt is not ported; the
 * ajv JSON-schema validation is replaced by a typed guard that checks only the fields this engine
 * reads, so unknown extra fields and a missing schemaVersion are accepted; peakSpeed is added.
 * Interpolation results match polar-math 1.1.1, which the spec uses as its oracle. The
 * `extrapolate: false` path and the full per-axis state labels have no production caller; they are
 * kept on purpose so the port stays at parity with that oracle.
 */

export interface PolarTarget { twa: number; tbs: number; vmg: number }
export interface PolarDerivedRow { tws: number; beat?: PolarTarget | null; run?: PolarTarget | null }

/** A polar table in SI units (m/s and rad), validated for everything the engine reads. */
export interface PolarTable {
  kind: 'polarTable';
  units: { tws: 'm/s'; twa: 'rad'; boatSpeed: 'm/s' };
  symmetry: { portStarboardSymmetric: true };
  axes: { tws: number[]; twa: number[] };
  values: { boatSpeedMatrix: number[][] };
  derived?: { rows?: PolarDerivedRow[] };
}

export type PolarTableResult = { ok: true; table: PolarTable } | { ok: false; reason: string };

export type PolarTwsState = 'below_range' | 'in_range' | 'above_range';
export type PolarTwaState = 'below_range' | 'in_range' | 'above_range' | 'in_irons' | 'pinching' | 'extrapolated';
export type PolarState =
  | { available: true; tws: PolarTwsState; twa: PolarTwaState | null }
  | { available: false; reason: 'invalid_input' | 'no_data'; tws: null; twa: null };

export interface PolarQuery {
  /** True wind speed, m/s. */
  tws: number;
  /** Multiplier on the table speeds; defaults to 1, negative is invalid. */
  performanceFactor?: number;
  /** Use the pinch-zone and run-side extensions beyond the table's own points; defaults to true. */
  extrapolate?: boolean;
}
export interface PolarSpeedQuery extends PolarQuery {
  /** True wind angle, rad, in [-π, π]; port and starboard are symmetric. */
  twa: number;
}
export interface PolarResult<T> { value: T | null; state: PolarState }
export interface PolarTwaRange { minTwa: number; maxTwa: number }
/** A best-VMG target: TWA in rad, target boat speed and its VMG in m/s. */
export interface PolarSideTarget { twa: number; speed: number; vmg: number }
export interface PolarTargets {
  /**
   * Best VMG upwind, or null when either TWS column around the query has no beat side, such as a
   * light-air column with no speeds below 90°. Null for one TWS says nothing about another.
   */
  beat: PolarSideTarget | null;
  /** Best VMG downwind, or null when either TWS column around the query has no run side. */
  run: PolarSideTarget | null;
  /** The fastest point and its TWA. */
  maxSpeed: { twa: number; speed: number };
}

const PINCH_FACTOR = 0.8;
const BEAT_ENDPOINT_ANGLE = 25 * Math.PI / 180;
const EPSILON = 1e-9;
const DEFAULT_PERFORMANCE_FACTOR = 1;
/** polar-math's synthetic zero-speed row, so speeds scale toward zero below the lowest column. */
const ZERO_ROW_TWS = 0.0001;
const DERIVED_ROW_TWS_MATCH = 1e-6;
const HALF_PI = Math.PI / 2;

const KNOTS_PER_MPS = 1.94384;
const SPEED_FACTORS_TO_MPS = new Map<string, number>([
  ['m/s', 1],
  ['kn', 1 / KNOTS_PER_MPS],
  ['kt', 1 / KNOTS_PER_MPS],
  ['kts', 1 / KNOTS_PER_MPS],
  ['knot', 1 / KNOTS_PER_MPS],
  ['knots', 1 / KNOTS_PER_MPS]
]);
const ANGLE_FACTORS_TO_RAD = new Map<string, number>([
  ['rad', 1],
  ['deg', Math.PI / 180],
  ['degree', Math.PI / 180],
  ['degrees', Math.PI / 180]
]);

interface Point { readonly twa: number; readonly speed: number }
interface Target { readonly twa: number; readonly tbs: number; readonly vmg: number }
interface RunFlatten { readonly anchorTwa: number; readonly anchorVmg: number; readonly a: number; readonly b: number }

/** One prepared TWS column: the curve points with their PCHIP tangents and targets. */
interface Entry {
  readonly tws: number;
  readonly points: readonly Point[];
  readonly tangents: readonly number[];
  readonly realPoints: readonly Point[];
  readonly realTangents: readonly number[];
  readonly runFlatten: RunFlatten | null;
  readonly beat: PolarSideTarget | null;
  readonly run: PolarSideTarget | null;
  readonly maxSpeed: number;
  readonly maxSpeedAngle: number;
}

interface TwsSpan { readonly lower: Entry; readonly upper: Entry; readonly ratio: number }

export class Polar {
  private readonly entries: readonly Entry[];

  constructor(table: PolarTable) {
    // The guard requires portStarboardSymmetric; every query mirrors TWA across the bow.
    this.entries = prepareEntries(table);
  }

  speedAt(query: PolarSpeedQuery): PolarResult<number> {
    const input = normalizeQuery(query);
    const { twa } = query;
    if (!input || !Number.isFinite(twa) || Math.abs(twa) > Math.PI) return { value: null, state: invalidState() };
    if (this.entries.length === 0) return { value: null, state: noDataState() };

    const span = this.findTwsSpan(input.tws);
    const state = this.stateAt(input.tws, twa, input.extrapolate, span);
    if (state.twa === 'below_range' || state.twa === 'in_irons' || state.twa === 'above_range') {
      return { value: null, state };
    }

    const normalizedTwa = Math.abs(twa);
    const lowerSpeed = speedFromEntry(span.lower, normalizedTwa, input.extrapolate);
    const upperSpeed = speedFromEntry(span.upper, normalizedTwa, input.extrapolate);
    if (lowerSpeed === null || upperSpeed === null) return { value: null, state };

    return { value: interpolate(lowerSpeed, upperSpeed, span.ratio) * input.performanceFactor, state };
  }

  rangeAt(query: PolarQuery): PolarResult<PolarTwaRange> {
    const input = normalizeQuery(query);
    if (!input) return { value: null, state: invalidState() };
    if (this.entries.length === 0) return { value: null, state: noDataState() };

    const span = this.findTwsSpan(input.tws);
    return {
      value: {
        minTwa: interpolate(minTwaForEntry(span.lower, input.extrapolate), minTwaForEntry(span.upper, input.extrapolate), span.ratio),
        maxTwa: interpolate(maxTwaForEntry(span.lower, input.extrapolate), maxTwaForEntry(span.upper, input.extrapolate), span.ratio)
      },
      state: validState(this.twsState(input.tws), null)
    };
  }

  /**
   * The beat and run targets and the fastest point for a TWS, interpolated between the TWS
   * columns and scaled by the performance factor. Outside the table the nearest column's targets
   * apply, and the state says so.
   */
  targetsAt(query: PolarQuery): PolarResult<PolarTargets> {
    const input = normalizeQuery(query);
    if (!input) return { value: null, state: invalidState() };
    if (this.entries.length === 0) return { value: null, state: noDataState() };

    const { lower, upper, ratio } = this.findTwsSpan(input.tws);
    const scale = input.performanceFactor;
    const side = (key: 'beat' | 'run'): PolarSideTarget | null => {
      const low = lower[key];
      const high = upper[key];
      if (!low || !high) return null;
      return {
        twa: interpolate(low.twa, high.twa, ratio),
        speed: interpolate(low.speed, high.speed, ratio) * scale,
        vmg: interpolate(low.vmg, high.vmg, ratio) * scale
      };
    };
    return {
      value: {
        beat: side('beat'),
        run: side('run'),
        maxSpeed: { twa: interpolate(lower.maxSpeedAngle, upper.maxSpeedAngle, ratio), speed: interpolate(lower.maxSpeed, upper.maxSpeed, ratio) * scale }
      },
      state: validState(this.twsState(input.tws), null)
    };
  }

  /** The fastest table speed at any TWS, at performance factor 1; null for a table with no speeds. */
  peakSpeed(): number | null {
    return this.entries.length === 0 ? null : Math.max(...this.entries.map(entry => entry.maxSpeed));
  }

  private findTwsSpan(tws: number): TwsSpan {
    let lowerIndex = -1;
    let upperIndex = -1;
    for (let index = 0; index < this.entries.length; index += 1) {
      if (this.entries[index].tws <= tws) lowerIndex = index;
      if (this.entries[index].tws >= tws && upperIndex === -1) upperIndex = index;
    }
    if (lowerIndex === -1) return { lower: this.entries[0], upper: this.entries[0], ratio: 0 };
    if (upperIndex === -1) {
      const lastEntry = last(this.entries);
      return { lower: lastEntry, upper: lastEntry, ratio: 0 };
    }
    const lower = this.entries[lowerIndex];
    const upper = this.entries[upperIndex];
    if (lowerIndex === upperIndex) return { lower, upper, ratio: 0 };
    return { lower, upper, ratio: (tws - lower.tws) / (upper.tws - lower.tws) };
  }

  private twsState(tws: number): PolarTwsState {
    // Index 0 is the synthetic zero row; the table's own range starts at index 1.
    const first = this.entries[1] ?? this.entries[0];
    if (tws < first.tws) return 'below_range';
    if (tws > last(this.entries).tws) return 'above_range';
    return 'in_range';
  }

  private stateAt(tws: number, twa: number, extrapolate: boolean, span: TwsSpan): PolarState {
    const { lower, upper, ratio } = span;
    const normalizedTwa = Math.abs(twa);
    const minTwa = interpolate(minTwaForEntry(lower, extrapolate), minTwaForEntry(upper, extrapolate), ratio);
    const maxTwa = interpolate(maxTwaForEntry(lower, extrapolate), maxTwaForEntry(upper, extrapolate), ratio);

    if (!extrapolate) {
      let twaState: PolarTwaState = 'in_range';
      if (normalizedTwa < minTwa) twaState = 'below_range';
      else if (normalizedTwa > maxTwa) twaState = 'above_range';
      return validState(this.twsState(tws), twaState);
    }

    const beatAngle = lower.beat && upper.beat
      ? interpolate(lower.beat.twa, upper.beat.twa, ratio)
      : null;
    let twaState: PolarTwaState = 'in_range';
    if (normalizedTwa < minTwa) twaState = beatAngle !== null ? 'in_irons' : 'below_range';
    else if (beatAngle !== null && normalizedTwa < beatAngle) twaState = 'pinching';
    else {
      const lastTwa = Math.max(last(lower.points).twa, last(upper.points).twa);
      if (normalizedTwa > maxTwa) twaState = 'above_range';
      else if (normalizedTwa > lastTwa) twaState = 'extrapolated';
    }
    return validState(this.twsState(tws), twaState);
  }
}

function validState(tws: PolarTwsState, twa: PolarTwaState | null): PolarState {
  return { available: true, tws, twa };
}

function invalidState(): PolarState {
  return { available: false, reason: 'invalid_input', tws: null, twa: null };
}

function noDataState(): PolarState {
  return { available: false, reason: 'no_data', tws: null, twa: null };
}

function normalizeQuery(query: PolarQuery): Required<PolarQuery> | null {
  const { tws, performanceFactor = DEFAULT_PERFORMANCE_FACTOR, extrapolate = true } = query;
  if (!Number.isFinite(tws) || !Number.isFinite(performanceFactor) || performanceFactor < 0) return null;
  return { tws, performanceFactor, extrapolate };
}

function interpolate(a: number, b: number, ratio: number): number {
  return a + ratio * (b - a);
}

function last<T>(items: readonly T[]): T {
  return items[items.length - 1];
}

function vmgOf(point: Point): number {
  return point.speed * Math.abs(Math.cos(point.twa));
}

function prepareEntries(table: PolarTable): Entry[] {
  const targets = fillDerivedTargets(table.axes.tws, table.derived?.rows ?? []);
  const entries: Entry[] = [];
  table.axes.tws.forEach((tws, rowIndex) => {
    const axisPoints = table.axes.twa
      .map((twa, colIndex) => ({ twa, speed: table.values.boatSpeedMatrix[rowIndex][colIndex] }))
      .filter(point => point.speed > 0);
    if (axisPoints.length === 0) return;

    const points: Point[] = axisPoints.slice();
    const beatTarget = points.some(point => point.twa < HALF_PI) ? targets[rowIndex].beat : null;
    const runTarget = points.some(point => point.twa >= HALF_PI) ? targets[rowIndex].run : null;
    addTarget(points, beatTarget);
    addTarget(points, runTarget);
    points.sort((a, b) => a.twa - b.twa);

    const beat = sideTarget(beatTarget, bestVmgPoint(points, point => point.twa < HALF_PI));
    const run = sideTarget(runTarget, bestVmgPoint(points, point => point.twa >= HALF_PI));
    const beatAngle = beat?.twa ?? null;
    const runAngle = run?.twa ?? null;
    const fastest = points.reduce((result, point) => point.speed > result.speed ? point : result, points[0]);
    const maxSpeed = fastest.speed;
    const realPoints = points.slice();

    const extended = addRunExtension(axisPoints, addBeatExtension(points, beatAngle), runAngle);
    const tangents = pchipTangents(extended);
    entries.push({
      tws,
      points: extended,
      tangents,
      realPoints,
      realTangents: pchipTangents(realPoints),
      runFlatten: buildRunFlatten(extended, tangents, runAngle),
      beat,
      run,
      maxSpeed,
      maxSpeedAngle: fastest.twa
    });
  });

  if (entries.length === 0) return [];

  const first = entries[0];
  const zeroRow: Entry = {
    tws: ZERO_ROW_TWS,
    points: first.points.map(point => ({ ...point, speed: 0 })),
    tangents: first.tangents.map(() => 0),
    realPoints: first.realPoints.map(point => ({ ...point, speed: 0 })),
    realTangents: first.realTangents.map(() => 0),
    runFlatten: first.runFlatten ? { ...first.runFlatten, anchorVmg: 0, a: 0, b: 0 } : null,
    beat: first.beat ? { twa: first.beat.twa, speed: 0, vmg: 0 } : null,
    run: first.run ? { twa: first.run.twa, speed: 0, vmg: 0 } : null,
    maxSpeed: 0,
    maxSpeedAngle: first.maxSpeedAngle
  };
  return [zeroRow, ...entries];
}

// A column's target: the derived row's own, else its best-VMG point. A derived VMG is rounded to
// hundredths, as polar-math does, so the two stay at parity.
function sideTarget(target: Target | null, best: Point | null): PolarSideTarget | null {
  if (target) return { twa: target.twa, speed: target.tbs, vmg: roundToHundredths(target.vmg) };
  return best ? { twa: best.twa, speed: best.speed, vmg: roundToHundredths(vmgOf(best)) } : null;
}

function roundToHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

function bestVmgPoint(points: readonly Point[], predicate: (point: Point) => boolean): Point | null {
  return points.filter(predicate).reduce<Point | null>(
    (result, point) => !result || vmgOf(point) > vmgOf(result) ? point : result, null);
}

function addTarget(points: Point[], target: Target | null): void {
  if (!target) return;
  const index = points.findIndex(point => point.twa === target.twa);
  const point = { twa: target.twa, speed: target.tbs };
  if (index >= 0) points[index] = point;
  else points.push(point);
}

// Prepends a synthetic zero-speed endpoint so the PCHIP curve reaches 25° on the beat side
// without using the query cutoff to shape the curve.
function addBeatExtension(points: Point[], beatAngle: number | null): Point[] {
  if (beatAngle === null || beatAngle <= BEAT_ENDPOINT_ANGLE) return points;
  if (points[0].twa <= BEAT_ENDPOINT_ANGLE + EPSILON) return points;
  return [{ twa: BEAT_ENDPOINT_ANGLE, speed: 0 }, ...points];
}

// Extends the run side with at most one point mirrored across the run target angle, beyond
// the deepest known angle; buildRunFlatten tapers from there to 180°.
function addRunExtension(axisPoints: readonly Point[], points: Point[], runAngle: number | null): Point[] {
  if (runAngle === null) return points;

  const reference = findReferencePoint(axisPoints, runAngle);
  if (reference === null) return points;

  let mirrorAngle = 2 * runAngle - reference.twa;
  if (Math.abs(mirrorAngle - Math.PI) < EPSILON) mirrorAngle = Math.PI;
  const mirrorCosine = Math.abs(Math.cos(mirrorAngle));
  // A mirror point beyond 180° is skipped rather than clamped: clamped at π it would encode
  // the wrong VMG right at the boundary.
  if (mirrorAngle > Math.PI || mirrorAngle <= last(points).twa + EPSILON || mirrorCosine <= EPSILON) return points;

  const mirrorSpeed = Math.max(0, vmgOf(reference) / mirrorCosine);
  return [...points, { twa: mirrorAngle, speed: mirrorSpeed }].sort((a, b) => a.twa - b.twa);
}

// The table point with the largest TWA whose whole-degree angle is below the rounded run angle.
function findReferencePoint(axisPoints: readonly Point[], runAngle: number): Point | null {
  const roundedRunDeg = Math.round(runAngle * 180 / Math.PI);
  let best: Point | null = null;
  for (const point of axisPoints) {
    const deg = Math.round(point.twa * 180 / Math.PI);
    if (deg < roundedRunDeg && (best === null || point.twa > best.twa)) best = point;
  }
  return best;
}

// Quadratic VMG taper from the deepest known point to zero VMG slope at 180°. The initial slope
// is the PCHIP tangent there converted to dVMG/dTWA, so the taper is slope-continuous.
function buildRunFlatten(points: readonly Point[], tangents: readonly number[], runAngle: number | null): RunFlatten | null {
  if (runAngle === null) return null;
  const anchor = last(points);
  if (points.length < 2 || anchor.twa >= Math.PI - EPSILON) return null;

  // VMG magnitude is -speed·cos(twa) for twa in (π/2, π]; differentiate with the product rule.
  const slope = Math.min(0, -last(tangents) * Math.cos(anchor.twa) + anchor.speed * Math.sin(anchor.twa));
  const distanceToEnd = Math.PI - anchor.twa;
  return { anchorTwa: anchor.twa, anchorVmg: vmgOf(anchor), a: -slope / (2 * distanceToEnd), b: slope };
}

// Fritsch-Carlson monotone cubic Hermite (PCHIP) tangents for a sorted point list: interior
// tangents are a weighted harmonic mean of the adjacent secants (zero at local extrema), and
// endpoints use the one-sided three-point estimate with the same shape-preserving clamp.
function pchipTangents(points: readonly Point[]): number[] {
  const n = points.length;
  const tangents = new Array<number>(n).fill(0);
  if (n < 2) return tangents;

  const h: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    h.push(points[i + 1].twa - points[i].twa);
    m.push((points[i + 1].speed - points[i].speed) / h[i]);
  }

  if (n === 2) {
    tangents[0] = m[0];
    tangents[1] = m[0];
    return tangents;
  }

  for (let i = 1; i < n - 1; i += 1) {
    if (m[i - 1] === 0 || m[i] === 0 || (m[i - 1] > 0) !== (m[i] > 0)) {
      tangents[i] = 0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      tangents[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i]);
    }
  }
  tangents[0] = pchipEndpointTangent(h[0], h[1], m[0], m[1]);
  tangents[n - 1] = pchipEndpointTangent(h[n - 2], h[n - 3], m[n - 2], m[n - 3]);
  return tangents;
}

function pchipEndpointTangent(h0: number, h1: number, m0: number, m1: number): number {
  let tangent = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1);
  if (tangent !== 0 && m0 !== 0 && (tangent > 0) !== (m0 > 0)) tangent = 0;
  else if (m0 !== 0 && m1 !== 0 && (m0 > 0) !== (m1 > 0) && Math.abs(tangent) > Math.abs(3 * m0)) tangent = 3 * m0;
  return tangent;
}

// Evaluates the monotone cubic Hermite curve at twa; null below the first point.
function evaluatePchip(points: readonly Point[], tangents: readonly number[], twa: number): number | null {
  if (twa < points[0].twa) return null;
  if (points.length === 1) return twa === points[0].twa ? points[0].speed : null;

  let index = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    if (points[i].twa <= twa) index = i;
  }

  const p0 = points[index];
  const p1 = points[index + 1];
  const h = p1.twa - p0.twa;
  const t = (twa - p0.twa) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return Math.max(0, h00 * p0.speed + h10 * h * tangents[index] + h01 * p1.speed + h11 * h * tangents[index + 1]);
}

function speedFromEntry(entry: Entry, twa: number, extrapolate: boolean): number | null {
  const points = extrapolate ? entry.points : entry.realPoints;
  const tangents = extrapolate ? entry.tangents : entry.realTangents;
  if (twa > last(points).twa) {
    if (!extrapolate || !entry.runFlatten) return null;
    const { anchorTwa, anchorVmg, a, b } = entry.runFlatten;
    const x = twa - anchorTwa;
    const vmg = Math.min(anchorVmg, anchorVmg + b * x + a * x * x);
    const cosine = Math.abs(Math.cos(twa));
    return cosine < EPSILON ? null : Math.max(0, vmg / cosine);
  }
  return evaluatePchip(points, tangents, twa);
}

function minTwaForEntry(entry: Entry, extrapolate: boolean): number {
  if (!extrapolate) return entry.realPoints[0].twa;
  return entry.beat
    ? BEAT_ENDPOINT_ANGLE + PINCH_FACTOR * (entry.beat.twa - BEAT_ENDPOINT_ANGLE)
    : entry.points[0].twa;
}

function maxTwaForEntry(entry: Entry, extrapolate: boolean): number {
  if (!extrapolate) return last(entry.realPoints).twa;
  return entry.runFlatten ? Math.PI : last(entry.points).twa;
}

interface ColumnTargets { beat: Target | null; run: Target | null }

// Resolves the beat and run targets for every TWS column: a derived row's own target, else a
// linear interpolation between the nearest columns that have one, else a copy of the nearest.
// Columns are filled in order, so a filled column can serve as the neighbor of the next one.
function fillDerivedTargets(twsAxis: readonly number[], rows: readonly PolarDerivedRow[]): ColumnTargets[] {
  const targets: ColumnTargets[] = twsAxis.map(tws => {
    const row = rows.find(candidate => Math.abs(candidate.tws - tws) < DERIVED_ROW_TWS_MATCH);
    return { beat: row?.beat ? { ...row.beat } : null, run: row?.run ? { ...row.run } : null };
  });
  for (const key of ['beat', 'run'] as const) {
    for (let index = 0; index < targets.length; index += 1) {
      if (targets[index][key]) continue;
      const lower = findTargetIndex(targets, key, index, -1);
      const upper = findTargetIndex(targets, key, index, 1);
      const low = lower >= 0 ? targets[lower][key] : null;
      const high = upper >= 0 ? targets[upper][key] : null;
      if (low && high) {
        const ratio = (twsAxis[index] - twsAxis[lower]) / (twsAxis[upper] - twsAxis[lower]);
        const twa = interpolate(low.twa, high.twa, ratio);
        const tbs = interpolate(low.tbs, high.tbs, ratio);
        targets[index][key] = { twa, tbs, vmg: tbs * Math.abs(Math.cos(twa)) };
      } else if (low) targets[index][key] = { ...low };
      else if (high) targets[index][key] = { ...high };
    }
  }
  return targets;
}

function findTargetIndex(targets: readonly ColumnTargets[], key: keyof ColumnTargets, from: number, direction: 1 | -1): number {
  for (let index = from + direction; index >= 0 && index < targets.length; index += direction) {
    if (targets[index][key]) return index;
  }
  return -1;
}

/**
 * Converts a polar table in any supported units to SI (m/s, rad) and validates every field the
 * engine reads. Unknown extra fields are ignored and dropped from the result.
 */
export function toCanonicalPolarTable(data: unknown): PolarTableResult {
  if (!isRecord(data)) return { ok: false, reason: '/ must be a polar table object' };

  const errors: string[] = [];
  if (data['kind'] !== 'polarTable') errors.push('/kind must be polarTable');
  if (field(data['symmetry'], 'portStarboardSymmetric') !== true) {
    errors.push('/symmetry/portStarboardSymmetric must be true');
  }

  const units = data['units'];
  if (!isRecord(units)) errors.push('/units must be an object');
  const twsFactor = unitFactor(field(units, 'tws'), SPEED_FACTORS_TO_MPS, '/units/tws', errors);
  const twaFactor = unitFactor(field(units, 'twa'), ANGLE_FACTORS_TO_RAD, '/units/twa', errors);
  const speedFactor = unitFactor(field(units, 'boatSpeed'), SPEED_FACTORS_TO_MPS, '/units/boatSpeed', errors);

  const axes = data['axes'];
  const twsAxis = readAxis(field(axes, 'tws'), '/axes/tws', true, errors);
  const twaAxis = readAxis(field(axes, 'twa'), '/axes/twa', false, errors);
  const matrix = readMatrix(field(data['values'], 'boatSpeedMatrix'), twsAxis, twaAxis, errors);
  const derived = readDerived(data['derived'], errors);

  if (errors.length > 0 || twsFactor === undefined || twaFactor === undefined || speedFactor === undefined ||
      !twsAxis || !twaAxis || !matrix || derived === null) {
    return { ok: false, reason: errors.join('; ') };
  }

  const table: PolarTable = {
    kind: 'polarTable',
    units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' },
    symmetry: { portStarboardSymmetric: true },
    axes: { tws: twsAxis.map(value => value * twsFactor), twa: twaAxis.map(value => value * twaFactor) },
    values: { boatSpeedMatrix: matrix.map(row => row.map(value => value * speedFactor)) }
  };
  if (derived) {
    table.derived = derived.rows ? { rows: derived.rows.map(row => convertDerivedRow(row, twsFactor, twaFactor, speedFactor)) } : {};
  }

  const rangeErrors = canonicalRangeErrors(table);
  return rangeErrors.length > 0 ? { ok: false, reason: rangeErrors.join('; ') } : { ok: true, table };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function unitFactor(unit: unknown, factors: ReadonlyMap<string, number>, path: string, errors: string[]): number | undefined {
  const factor = typeof unit === 'string' ? factors.get(unit) : undefined;
  if (factor === undefined) errors.push(`${path} must be one of ${[...factors.keys()].join(', ')}`);
  return factor;
}

function readNumbers(value: unknown, path: string, positive: boolean, errors: string[]): number[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path} must be a non-empty array`);
    return null;
  }
  const numbers: number[] = [];
  value.forEach((item: unknown, index: number) => {
    if (!isFiniteNumber(item)) errors.push(`${path}/${index} must be a finite number`);
    else if (positive ? item <= 0 : item < 0) errors.push(`${path}/${index} must be ${positive ? '> 0' : '>= 0'}`);
    else numbers.push(item);
  });
  return numbers.length === value.length ? numbers : null;
}

function readAxis(value: unknown, path: string, positive: boolean, errors: string[]): number[] | null {
  const axis = readNumbers(value, path, positive, errors);
  if (!axis) return null;
  const decreasing = axis.findIndex((item, index) => index > 0 && item <= axis[index - 1]);
  if (decreasing >= 0) {
    errors.push(`${path}/${decreasing} must be strictly increasing`);
    return null;
  }
  return axis;
}

function readMatrix(value: unknown, twsAxis: number[] | null, twaAxis: number[] | null, errors: string[]): number[][] | null {
  const path = '/values/boatSpeedMatrix';
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return null;
  }
  let valid = true;
  if (twsAxis && value.length !== twsAxis.length) {
    errors.push(`${path} row count must match axes.tws length`);
    valid = false;
  }
  const rows = value.map((row: unknown, rowIndex: number) => {
    if (Array.isArray(row) && twaAxis && row.length !== twaAxis.length) {
      errors.push(`${path}/${rowIndex} length must match axes.twa length`);
      valid = false;
    }
    return readNumbers(row, `${path}/${rowIndex}`, false, errors);
  });
  if (!valid || rows.some(row => row === null)) return null;
  return rows.filter((row): row is number[] => row !== null);
}

/** Returns the derived block (undefined when absent), or null when it is malformed. */
function readDerived(value: unknown, errors: string[]): { rows?: PolarDerivedRow[] } | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push('/derived must be an object');
    return null;
  }
  const rows = value['rows'];
  if (rows === undefined) return {};
  if (!Array.isArray(rows)) {
    errors.push('/derived/rows must be an array');
    return null;
  }
  const errorCount = errors.length;
  const parsed = rows.map((row: unknown, index: number) => readDerivedRow(row, `/derived/rows/${index}`, errors));
  return errors.length === errorCount ? { rows: parsed } : null;
}

function readDerivedRow(row: unknown, path: string, errors: string[]): PolarDerivedRow {
  const tws = field(row, 'tws');
  if (!isRecord(row)) errors.push(`${path} must be an object`);
  else if (!isFiniteNumber(tws) || tws <= 0) errors.push(`${path}/tws must be a number > 0`);
  const result: PolarDerivedRow = { tws: isFiniteNumber(tws) ? tws : 0 };
  const beat = readTarget(field(row, 'beat'), `${path}/beat`, errors);
  const run = readTarget(field(row, 'run'), `${path}/run`, errors);
  if (beat !== undefined) result.beat = beat;
  if (run !== undefined) result.run = run;
  return result;
}

function readTarget(value: unknown, path: string, errors: string[]): PolarTarget | null | undefined {
  if (value === undefined || value === null) return value;
  const twa = field(value, 'twa');
  const tbs = field(value, 'tbs');
  const vmg = field(value, 'vmg');
  if (isFiniteNumber(twa) && twa >= 0 && isFiniteNumber(tbs) && tbs >= 0 && isFiniteNumber(vmg)) return { twa, tbs, vmg };
  errors.push(`${path} must have a twa >= 0, a tbs >= 0 and a vmg`);
  return undefined;
}

function convertDerivedRow(row: PolarDerivedRow, twsFactor: number, twaFactor: number, speedFactor: number): PolarDerivedRow {
  const convertTarget = (target: PolarTarget | null): PolarTarget | null => target === null ? null : {
    twa: target.twa * twaFactor,
    tbs: target.tbs * speedFactor,
    vmg: target.vmg * speedFactor
  };
  const converted: PolarDerivedRow = { tws: row.tws * twsFactor };
  if (row.beat !== undefined) converted.beat = convertTarget(row.beat);
  if (row.run !== undefined) converted.run = convertTarget(row.run);
  return converted;
}

function canonicalRangeErrors(table: PolarTable): string[] {
  const errors: string[] = [];
  table.axes.twa.forEach((twa, index) => {
    if (twa > Math.PI) errors.push(`/axes/twa/${index} must be <= pi radians`);
  });
  table.derived?.rows?.forEach((row, index) => {
    if (row.beat && row.beat.twa > Math.PI) errors.push(`/derived/rows/${index}/beat/twa must be <= pi radians`);
    if (row.run && row.run.twa > Math.PI) errors.push(`/derived/rows/${index}/run/twa must be <= pi radians`);
  });
  return errors;
}
