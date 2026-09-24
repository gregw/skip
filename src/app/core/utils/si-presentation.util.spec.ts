import { describe, expect, it } from 'vitest';
import { presentationValue, toDegrees } from './si-presentation.util';

describe('toDegrees', () => {
  it('converts rad to degrees and passes null and undefined through', () => {
    expect(toDegrees(Math.PI)).toBe(180);
    expect(toDegrees(null)).toBeNull();
    expect(toDegrees(undefined)).toBeUndefined();
  });
});

describe('presentationValue', () => {
  const units = { convertToUnit: (unit: string, value: number) => unit === 'knots' ? value * 1.94384 : null };

  it('converts an SI value to its presentation measure', () => {
    expect(presentationValue(units, 'knots', 5)).toBeCloseTo(9.7192, 6);
  });

  it('leaves the SI value for an empty, unitless or unknown measure', () => {
    expect(presentationValue(units, '', 5)).toBe(5);
    expect(presentationValue(units, 'unitless', 5)).toBe(5);
    expect(presentationValue(units, 'no-such-measure', 5)).toBe(5);
  });
});
