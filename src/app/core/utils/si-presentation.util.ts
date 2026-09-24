/**
 * Presentation conversions for widgets that compute in SI (halos-org/skip#639): the values they
 * receive and hold are SI, and these convert only where a value is drawn or written as text.
 */
import type { UnitsService } from '../services/units.service';

export const RAD_TO_DEG = 180 / Math.PI;

/** An angle given in rad, in degrees; null and undefined pass through. */
export function toDegrees(rad: number): number;
export function toDegrees(rad: number | undefined): number | undefined;
export function toDegrees(rad: number | null): number | null;
export function toDegrees(rad: number | null | undefined): number | null | undefined {
  return rad == null ? rad : rad * RAD_TO_DEG;
}

/**
 * An SI value in its presentation measure, for a readout. An empty or unitless measure, which has
 * no symbol to show beside the number, and a measure the converter does not know leave it in SI.
 */
export function presentationValue(units: Pick<UnitsService, 'convertToUnit'>, measure: string, si: number): number {
  return measure && measure !== 'unitless' ? (units.convertToUnit(measure, si) ?? si) : si;
}
