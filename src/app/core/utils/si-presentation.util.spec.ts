import { describe, expect, it } from 'vitest';
import { presentationValue, presentedOption, toDegrees } from './si-presentation.util';

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

describe('presentedOption', () => {
  it('drops the float noise of a unit round trip', () => {
    expect(30 * Math.PI / 180 * 180 / Math.PI).not.toBe(30);
    expect(presentedOption(30 * Math.PI / 180 * 180 / Math.PI)).toBe(30);
    expect(presentedOption(119.99999999999997)).toBe(120);
  });

  it('keeps a value that has ten significant digits of its own', () => {
    expect(presentedOption(12.34567891)).toBe(12.34567891);
  });
});
