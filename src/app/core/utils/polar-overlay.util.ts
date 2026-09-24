import { Polar } from './polar-engine.util';

/** One curve sample: `angle` in rad, clockwise; `r` in viewBox units from the dial center. */
export interface OverlayPoint { readonly angle: number; readonly r: number }

/**
 * The fixed speed-to-radius scale of one active polar: `peakSpeed` (m/s, the polar's peak at
 * performance factor 1) maps to `peakRadius`, and no radius exceeds `dialRadius`.
 */
export interface OverlayScale { readonly peakSpeed: number; readonly peakRadius: number; readonly dialRadius: number }

/**
 * Polar speeds (m/s) for one TWS and performance factor at TWA k·VMC_HEADING_STEP for
 * k = 0…π/VMC_HEADING_STEP, zero where the polar has no speed. Computed once per TWS and reused
 * for every VMC recompute as TWD and BTW change.
 */
export type PolarSpeedProfile = readonly number[];

/**
 * Keys of the Wind Steer config slots the polar features read: TWS (m/s) for the overlay and the
 * polar lines, water TWA (rad) and STW (m/s) for the overlay. Shared with the options dialog, which
 * checks them without loading the widget.
 */
export const POLAR_PATH_KEYS = ['polarTrueWindSpeed', 'polarTrueWindAngle', 'polarSpeedThroughWater'] as const;

/** TWA spacing of the polar curve samples (2°). */
export const POLAR_CURVE_TWA_STEP = Math.PI / 90;
/** Heading spacing of the VMC curve samples (2°); divides π evenly. */
export const VMC_HEADING_STEP = Math.PI / 90;

const TWO_PI = 2 * Math.PI;
const PROFILE_LAST_INDEX = Math.round(Math.PI / VMC_HEADING_STEP);

/** Radius for a boat speed (m/s), shared by the curves and the polar dot; 0 for no speed. */
export function speedToRadius(speed: number, scale: OverlayScale): number {
  const { peakSpeed, peakRadius, dialRadius } = scale;
  if (!(speed > 0) || !(peakSpeed > 0)) return 0;
  return Math.min(dialRadius, speed / peakSpeed * peakRadius);
}

/**
 * The polar curve for one TWS in the wind frame: `angle` is the heading relative to the true
 * wind direction (−TWA), so rotating the curve by the present TWA puts the present TWA's sample
 * on the bow. An open arc from the starboard beat angle round the stern to the port one; the
 * in-irons wedge is left undrawn.
 */
export function polarCurve(polar: Polar, tws: number, performanceFactor: number, scale: OverlayScale): OverlayPoint[] {
  const range = polar.rangeAt({ tws }).value;
  if (!range) return [];

  const { minTwa, maxTwa } = range;
  const steps = Math.max(1, Math.ceil((maxTwa - minTwa) / POLAR_CURVE_TWA_STEP));
  const starboard: OverlayPoint[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const twa = index === steps ? maxTwa : minTwa + (maxTwa - minTwa) * index / steps;
    starboard.push({ angle: -twa, r: speedToRadius(speedOrZero(polar, tws, twa, performanceFactor), scale) });
  }
  const port = starboard.map(point => ({ angle: -point.angle, r: point.r })).reverse();
  return [...starboard, ...port];
}

/** The per-TWS speed profile that vmcCurve reads. */
export function polarSpeedProfile(polar: Polar, tws: number, performanceFactor: number): PolarSpeedProfile {
  const speeds: number[] = [];
  for (let index = 0; index <= PROFILE_LAST_INDEX; index += 1) {
    speeds.push(speedOrZero(polar, tws, Math.min(Math.PI, index * VMC_HEADING_STEP), performanceFactor));
  }
  return speeds;
}

/**
 * The VMC curve in the compass frame: `angle` is the true heading in [0, 2π), and `r` is the
 * scaled polar speed · cos(heading − BTW), zero where that is negative. TWD and BTW are in rad.
 * Headings are spaced VMC_HEADING_STEP apart, offset so that every TWA falls on a profile sample.
 */
export function vmcCurve(profile: PolarSpeedProfile, twd: number, btw: number, scale: OverlayScale): OverlayPoint[] {
  const lastIndex = profile.length - 1;
  const points: OverlayPoint[] = [];
  // TWA = TWD − heading, from π down to just above −π, so headings run clockwise.
  for (let index = lastIndex; index > -lastIndex; index -= 1) {
    const heading = normalizeRadians(twd - index * VMC_HEADING_STEP);
    const vmc = profile[Math.abs(index)] * Math.cos(heading - btw);
    points.push({ angle: heading, r: speedToRadius(vmc, scale) });
  }
  return points;
}

/**
 * The stroked outline of a VMC curve: its runs of consecutive samples with a radius, so the edge
 * has no radial lines to the center where the curve drops to zero (the in-irons wedge, VMC ≤ 0).
 * A single-sample run is dropped, as a one-point stroke draws nothing. With no zero sample the
 * outline is the whole loop, closed.
 */
export function vmcEdgeRuns(points: readonly OverlayPoint[]): OverlayPoint[][] {
  const start = points.findIndex(point => !(point.r > 0));
  if (start < 0) return points.length ? [[...points, points[0]]] : [];

  const runs: OverlayPoint[][] = [];
  let run: OverlayPoint[] = [];
  // Walk the loop once from a zero sample, so a run that spans the list's end stays whole.
  for (let step = 1; step <= points.length; step += 1) {
    const point = points[(start + step) % points.length];
    if (point.r > 0) {
      run.push(point);
    } else {
      if (run.length > 1) runs.push(run);
      run = [];
    }
  }
  return runs;
}

/**
 * The overlay part way (t in [0, 1]) from one curve to the next, sample by sample: the radius
 * linearly and the angle along the shorter arc. Curves with different sample counts don't pair
 * up, so the target is returned as is.
 */
export function interpolateOverlay(from: readonly OverlayPoint[], to: OverlayPoint[], t: number): OverlayPoint[] {
  if (t >= 1 || from.length !== to.length) return to;
  return to.map((target, index) => {
    const source = from[index];
    const turn = normalizeRadians(target.angle - source.angle + Math.PI) - Math.PI;
    return { angle: source.angle + turn * t, r: source.r + (target.r - source.r) * t };
  });
}

/** A tack's best VMC heading: `twa` unsigned in rad, `angle` the true heading in rad, `r` its scaled VMC. */
export interface VmcOptimum extends OverlayPoint { readonly twa: number }

/**
 * How much (as a fraction) another VMC peak on the same tack must beat the marked one before the
 * marker moves to it, so it does not flip between two nearly equal peaks.
 */
export const VMC_OPTIMUM_SWITCH_MARGIN = 0.02;

/**
 * The best VMC heading on one tack toward BTW, or null when no heading on that tack has a positive
 * VMC. The best sample is refined with a parabola through its neighbours, so the marker moves
 * smoothly between the 2° samples. With the previous marker's TWA given, the marker stays on the
 * peak nearest it unless another peak beats that one by VMC_OPTIMUM_SWITCH_MARGIN. TWD and BTW in rad.
 */
export function vmcOptimum(
  profile: PolarSpeedProfile, twd: number, btw: number, scale: OverlayScale,
  tack: 'port' | 'starboard', previousTwa: number | null
): VmcOptimum | null {
  const lastIndex = profile.length - 1;
  // TWA = TWD − heading is positive with the wind over starboard.
  const sign = tack === 'starboard' ? 1 : -1;
  // Past dead downwind the samples continue on the other tack, mirrored in the profile.
  const vmcAt = (index: number): number =>
    profile[index > lastIndex ? 2 * lastIndex - index : index] * Math.cos(twd - sign * index * VMC_HEADING_STEP - btw);

  let best = -1;
  for (let index = 1; index <= lastIndex; index += 1) {
    const vmc = vmcAt(index);
    if (vmc > 0 && (best < 0 || vmc > vmcAt(best))) best = index;
  }
  if (best < 0) return null;

  let peak = best;
  if (previousTwa !== null) {
    let local = Math.min(lastIndex, Math.max(1, Math.round(previousTwa / VMC_HEADING_STEP)));
    for (;;) {
      const up = local < lastIndex && vmcAt(local + 1) > vmcAt(local) ? local + 1 : local;
      const next = local > 1 && vmcAt(local - 1) > vmcAt(up) ? local - 1 : up;
      if (next === local) break;
      local = next;
    }
    if (vmcAt(local) > 0 && vmcAt(best) <= vmcAt(local) * (1 + VMC_OPTIMUM_SWITCH_MARGIN)) peak = local;
  }

  const [before, at, after] = [vmcAt(peak - 1), vmcAt(peak), vmcAt(peak + 1)];
  const curvature = before - 2 * at + after;
  // A peak on the edge of the in-irons wedge, where the polar speed drops to 0, is not a smooth
  // maximum; a parabola through the edge would overshoot it.
  const smooth = before > 0 && after > 0 && curvature < 0;
  const offset = smooth ? Math.min(0.5, Math.max(-0.5, (before - after) / (2 * curvature))) : 0;
  const vmc = at - (before - after) * offset / 4;
  const twa = Math.min(Math.PI, (peak + offset) * VMC_HEADING_STEP);
  return { twa, angle: normalizeRadians(twd - sign * twa), r: speedToRadius(vmc, scale) };
}

/** Radius of the VMC dot on the bow axis from STW · cos(HDG − BTW); null when that is zero or less. */
export function vmcDotRadius(stw: number, hdg: number, btw: number, scale: OverlayScale): number | null {
  const vmc = stw * Math.cos(hdg - btw);
  return vmc > 0 ? speedToRadius(vmc, scale) : null;
}

function speedOrZero(polar: Polar, tws: number, twa: number, performanceFactor: number): number {
  return polar.speedAt({ tws, twa, performanceFactor }).value ?? 0;
}

/** An angle in rad mapped into [0, 2π). */
export function normalizeRadians(angle: number): number {
  return ((angle % TWO_PI) + TWO_PI) % TWO_PI;
}
