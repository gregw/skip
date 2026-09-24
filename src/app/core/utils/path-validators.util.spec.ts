import { describe, expect, it } from 'vitest';
import { UntypedFormControl, UntypedFormGroup } from '@angular/forms';
import { IPathSlotRequirements, pathPointerValidator, pathRequiredValidator, pathSlotWarning } from './path-validators.util';
import type { ISkPathData } from '../interfaces/app-interfaces';
import { ISkMetadata, States } from '../interfaces/signalk-interfaces';

const groupWith = (path: unknown, pathRequired?: boolean): UntypedFormGroup => {
  const controls: Record<string, UntypedFormControl> = { path: new UntypedFormControl(path) };
  if (pathRequired !== undefined) {
    controls['pathRequired'] = new UntypedFormControl(pathRequired);
  }
  return new UntypedFormGroup(controls);
};

describe('pathRequiredValidator', () => {
  it('rejects an empty required path', () => {
    expect(pathRequiredValidator(groupWith('', true).controls['path'])).toEqual({ required: true });
  });

  it('rejects a null required path', () => {
    expect(pathRequiredValidator(groupWith(null, true).controls['path'])).toEqual({ required: true });
  });

  it('treats a slot with no pathRequired flag as required', () => {
    expect(pathRequiredValidator(groupWith('').controls['path'])).toEqual({ required: true });
  });

  it('accepts an empty path in an optional slot', () => {
    expect(pathRequiredValidator(groupWith('', false).controls['path'])).toBeNull();
  });

  it('accepts a path the server does not currently publish', () => {
    // The instrument behind it may simply be switched off; blocking here would strand the config.
    expect(pathRequiredValidator(groupWith('self.steering.rudderAngle', true).controls['path'])).toBeNull();
  });
});

describe('pathPointerValidator', () => {
  const validate = (path: unknown) => pathPointerValidator(groupWith(path).controls['path']);

  it('accepts a plain path, an empty path and a well-formed pointer path', () => {
    expect(validate('self.navigation.position')).toBeNull();
    expect(validate('')).toBeNull();
    expect(validate(null)).toBeNull();
    expect(validate('self.navigation.position#/latitude')).toBeNull();
  });

  it('rejects a pointer that does not start with "/"', () => {
    expect(validate('self.navigation.position#latitude')).toEqual({ pointer: true });
  });

  it('rejects an empty or otherwise malformed pointer', () => {
    expect(validate('self.navigation.position#')).toEqual({ pointer: true });
    expect(validate('self.navigation.position##/a')).toEqual({ pointer: true });
    expect(validate('self.navigation.position#/a~2b')).toEqual({ pointer: true });
  });

  it('rejects a pointer with no path before "#"', () => {
    expect(validate('#/a')).toEqual({ pointer: true });
    expect(validate('  #/a')).toEqual({ pointer: true });
  });
});

describe('pathSlotWarning', () => {
  const numberSlot: IPathSlotRequirements =
    { pathType: 'number', supportsPutOnly: false, zonesOnly: false, selfOnly: true };

  const meta = (overrides: Partial<ISkMetadata> = {}): ISkMetadata =>
    ({ description: '', properties: {}, ...overrides });

  const pathData = (overrides: Partial<ISkPathData> = {}): ISkPathData => ({
    path: 'self.navigation.speedThroughWater',
    pathValue: 4.2,
    pathTimestamp: undefined,
    type: 'number',
    state: States.Normal,
    sources: {},
    ...overrides
  });

  it('says nothing for an empty path', () => {
    expect(pathSlotWarning('', null, numberSlot)).toBeNull();
    expect(pathSlotWarning(null, null, numberSlot)).toBeNull();
  });

  it('says nothing for a path that satisfies the slot', () => {
    expect(pathSlotWarning('self.navigation.speedThroughWater', pathData(), numberSlot)).toBeNull();
  });

  it('reports a path the server is not sending at all', () => {
    // Covers a typo, a missing "self." prefix, and an instrument switched off since server start.
    const warning = pathSlotWarning('self.steering.rudderAngle', null, numberSlot);
    expect(warning).toContain('not sending this path');
    expect(warning).toContain('switched off');
  });

  it('distinguishes a known path that has not sent a value yet', () => {
    // A meta-only entry whose units imply no type: published, but its type cannot be checked.
    const warning = pathSlotWarning('self.navigation.speedThroughWater', pathData({ type: undefined }), numberSlot);
    expect(warning).toContain('has not sent a value yet');
  });

  it('names both types when the path carries the wrong one', () => {
    const warning = pathSlotWarning('self.navigation.state', pathData({ type: 'string' }), numberSlot);
    expect(warning).toContain('sends text values');
    expect(warning).toContain('needs a number');
  });

  it('reports a read-only path in a slot that needs PUT', () => {
    const warning = pathSlotWarning('self.steering.autopilot.state', pathData({ meta: meta({ supportsPut: false }) }),
      { ...numberSlot, supportsPutOnly: true });
    expect(warning).toContain('read-only');
  });

  it('says nothing when a PUT slot gets a path that supports PUT', () => {
    expect(pathSlotWarning('self.steering.autopilot.state', pathData({ meta: meta({ supportsPut: true }) }),
      { ...numberSlot, supportsPutOnly: true })).toBeNull();
  });

  it('reports a path on another vessel when the slot is restricted to own vessel', () => {
    const warning = pathSlotWarning('vessels.urn:mrn:imo:mmsi:123456789.navigation.speedOverGround', pathData(), numberSlot);
    expect(warning).toContain('another vessel');
  });

  it('accepts a path on another vessel when the slot is not restricted', () => {
    expect(pathSlotWarning('vessels.urn:mrn:imo:mmsi:123456789.navigation.speedOverGround', pathData(),
      { ...numberSlot, selfOnly: false })).toBeNull();
  });

  it('reports a path with no alarm zones in a zones-only slot', () => {
    const warning = pathSlotWarning('self.navigation.speedThroughWater', pathData({ meta: meta({ zones: [] }) }),
      { ...numberSlot, zonesOnly: true });
    expect(warning).toContain('no alarm zones');
  });

  it('matches a non-runtime slot type against the path metadata', () => {
    // A slot type outside the JS runtime types is matched on meta.type, not the value's type.
    const dateSlot: IPathSlotRequirements = { ...numberSlot, pathType: 'position' };
    expect(pathSlotWarning('self.navigation.position', pathData({ meta: meta({ type: 'position' }) }), dateSlot)).toBeNull();
    expect(pathSlotWarning('self.navigation.position', pathData({ meta: meta({ type: 'other' }) }), dateSlot))
      .toContain('sends other values');
  });

  describe('for a pointer path', () => {
    const POSITION_META = meta({
      properties: {
        latitude: { type: 'number', units: 'deg', description: 'Latitude' },
        longitude: { type: 'number', units: 'deg', description: 'Longitude' },
        altitude: { type: 'number', units: 'm', description: 'Altitude' }
      }
    });
    const position = (overrides: Partial<ISkPathData> = {}): ISkPathData => pathData({
      path: 'self.navigation.position',
      pathValue: { latitude: 60.08, longitude: 21.97 },
      type: 'object',
      meta: POSITION_META,
      ...overrides
    });
    const field = (type = 'number'): ISkMetadata => meta({ type, units: 'deg' });

    it('says nothing for a declared field present in the latest value', () => {
      expect(pathSlotWarning('self.navigation.position#/latitude', position(), numberSlot, field())).toBeNull();
    });

    it('leaves a malformed pointer to the validator', () => {
      expect(pathSlotWarning('self.navigation.position#latitude', null, numberSlot)).toBeNull();
      expect(pathSlotWarning('#/latitude', null, numberSlot)).toBeNull();
    });

    it('reports a base path the server is not sending', () => {
      expect(pathSlotWarning('self.navigation.position#/latitude', null, numberSlot)).toContain('not sending this path');
    });

    it('reports a field the metadata does not declare, naming it', () => {
      expect(pathSlotWarning('self.navigation.position#/speed', position(), numberSlot, null)).toBe(
        'Signal K does not list a field "speed" for this path. The widget will show nothing unless the value contains it.');
    });

    it('reports a declared field that the latest value lacks', () => {
      expect(pathSlotWarning('self.navigation.position#/altitude', position(), numberSlot, field())).toBe(
        'Signal K is sending this path, but its latest value has no "altitude". The instrument may not report it.');
    });

    it('reports a declared field whose latest value is null', () => {
      const attitude = position({ path: 'self.navigation.attitude', pathValue: { roll: 0.1, pitch: 0, yaw: null } });
      expect(pathSlotWarning('self.navigation.attitude#/yaw', attitude, numberSlot, field()))
        .toContain('its latest value has no "yaw"');
    });

    it('names the field name, not the whole pointer, for a nested field', () => {
      expect(pathSlotWarning('self.environment.current#/set/true', position({ pathValue: { set: {} } }), numberSlot, field()))
        .toContain('has no "true"');
    });

    it('checks the slot type against the field type, not the base value type', () => {
      const attitude = position({ path: 'self.navigation.attitude', pathValue: { roll: 0.1 } });
      const warning = pathSlotWarning('self.navigation.attitude#/roll', attitude, { ...numberSlot, pathType: 'string' }, field());
      expect(warning).toContain('sends numeric values');
      expect(warning).toContain('needs text');
    });

    it('treats a JSON Schema integer field as a number', () => {
      expect(pathSlotWarning('self.navigation.position#/latitude', position(), numberSlot, field('integer'))).toBeNull();
    });

    it('falls back to the resolved value type when the field declares none', () => {
      const untyped = meta({});
      expect(pathSlotWarning('self.navigation.position#/latitude', position(), numberSlot, untyped)).toBeNull();
      expect(pathSlotWarning('self.navigation.position#/latitude', position(), { ...numberSlot, pathType: 'string' }, untyped))
        .toContain('sends numeric values');
    });

    it('reports a base path that has not sent a value yet rather than a missing field', () => {
      const metaOnly = position({ pathValue: undefined, type: undefined });
      expect(pathSlotWarning('self.navigation.position#/latitude', metaOnly, numberSlot, field()))
        .toContain('has not sent a value yet');
    });

    it('reports a pointer in a PUT slot before anything about the path', () => {
      // True whatever the server sends: a command goes to a whole path.
      expect(pathSlotWarning('self.navigation.position#/latitude', null, { ...numberSlot, supportsPutOnly: true }, null)).toBe(
        'This control sends commands to a whole path and cannot target a single field. Pick a path without "#".');
    });

    it('reports a pointer in a zones-only slot with the zones message', () => {
      expect(pathSlotWarning('self.navigation.position#/latitude', position(), { ...numberSlot, zonesOnly: true }, field()))
        .toContain('no alarm zones');
    });

    it('applies the own-vessel restriction to the base path', () => {
      const other = 'vessels.urn:mrn:imo:mmsi:123456789.navigation.position#/latitude';
      expect(pathSlotWarning(other, position(), numberSlot, field())).toContain('another vessel');
      expect(pathSlotWarning(other, position(), { ...numberSlot, selfOnly: false }, field())).toBeNull();
    });
  });
});
