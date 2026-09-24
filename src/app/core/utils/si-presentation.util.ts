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

// Significant digits an SI-stored option is presented with: enough to drop the float noise of a
// unit round trip (120 °C through K and back shows 120, not 119.99999999999997; 30° through rad
// shows 30, not 29.999999999999996).
const SI_OPTION_DISPLAY_DIGITS = 10;

/** An SI-stored option converted to its presentation unit, as the user entered it. */
export function presentedOption(converted: number): number {
  return Number(converted.toPrecision(SI_OPTION_DISPLAY_DIGITS));
}
