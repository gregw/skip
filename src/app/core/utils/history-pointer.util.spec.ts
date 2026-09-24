import { describe, expect, it } from 'vitest';
import { IHistoryValuesResponse } from '../services/history-api-client.service';
import { historyQueryTarget, resolvePointerInHistoryRows } from './history-pointer.util';

const response = (method: 'last' | 'avg', data: IHistoryValuesResponse['data']): IHistoryValuesResponse => ({
  context: 'vessels.self',
  range: { from: '2026-09-24T10:00:00Z', to: '2026-09-24T10:01:00Z' },
  values: [{ path: 'navigation.position', method }],
  data
});

describe('resolvePointerInHistoryRows', () => {
  it('replaces each object value with the field the pointer addresses', () => {
    const resolved = resolvePointerInHistoryRows(response('last', [
      ['2026-09-24T10:00:00Z', { latitude: 60.08, longitude: 21.97 }],
      ['2026-09-24T10:00:30Z', { latitude: 60.09, longitude: 21.98 }]
    ]), ['latitude']);

    expect(resolved.data).toEqual([
      ['2026-09-24T10:00:00Z', 60.08],
      ['2026-09-24T10:00:30Z', 60.09]
    ]);
  });

  it('resolves every value column and keeps the timestamp and column metadata', () => {
    const input = response('last', [
      ['2026-09-24T10:00:00Z', { roll: -0.0384 }, { roll: -0.02 }]
    ]);
    const resolved = resolvePointerInHistoryRows(input, ['roll']);

    expect(resolved.data).toEqual([['2026-09-24T10:00:00Z', -0.0384, -0.02]]);
    expect(resolved.values).toBe(input.values);
    expect(resolved.range).toBe(input.range);
  });

  it('gives null for rows that are not objects holding the field, such as influxdb2 [lon, lat] pairs', () => {
    const resolved = resolvePointerInHistoryRows(response('last', [
      ['2026-09-24T10:00:00Z', [21.97, 60.08]],
      ['2026-09-24T10:00:30Z', 60.08],
      ['2026-09-24T10:01:00Z', null],
      ['2026-09-24T10:01:30Z', { longitude: 21.97 }]
    ]), ['latitude']);

    expect(resolved.data.map(row => row[1])).toEqual([null, null, null, null]);
  });

  it('gives null for a field that is not a number', () => {
    const resolved = resolvePointerInHistoryRows(response('last', [
      ['2026-09-24T10:00:00Z', { state: 'alarm' }]
    ]), ['state']);

    expect(resolved.data).toEqual([['2026-09-24T10:00:00Z', null]]);
  });
});

describe('historyQueryTarget', () => {
  it('strips the own-vessel prefix from the base path and parses the pointer', () => {
    expect(historyQueryTarget(' vessels.self.navigation.attitude #/roll')).toEqual({
      basePath: 'vessels.self.navigation.attitude',
      historyPath: 'navigation.attitude',
      pointer: ['roll']
    });
  });

  it('keeps a plain path whole, with no pointer', () => {
    expect(historyQueryTarget('self.navigation.speedOverGround')).toEqual({
      basePath: 'self.navigation.speedOverGround',
      historyPath: 'navigation.speedOverGround',
      pointer: null
    });
  });

  it('leaves another vessel\'s path as it is', () => {
    expect(historyQueryTarget('vessels.urn:mrn:imo:mmsi:100000001.navigation.position#/latitude')?.historyPath)
      .toBe('vessels.urn:mrn:imo:mmsi:100000001.navigation.position');
  });

  it('rejects a malformed pointer', () => {
    expect(historyQueryTarget('self.navigation.attitude#roll')).toBeNull();
  });
});
