import type { Path } from '@jsonjoy.com/json-pointer';
import { IHistoryValuesResponse } from '../services/history-api-client.service';
import { resolvePointer } from './pointer-path.util';

/**
 * The response with every value column of every row replaced by the number `pointer` addresses in
 * it, so a query on an object-valued base path yields the series of one field. The History API
 * returns an object path's values as objects; any other shape resolves to null, which the graph
 * mapper treats as a missing sample.
 */
export function resolvePointerInHistoryRows(response: IHistoryValuesResponse, pointer: Path): IHistoryValuesResponse {
  return {
    ...response,
    data: response.data.map(row => row.map((cell, index) => {
      if (index === 0) return cell;
      const field = resolvePointer(cell, pointer);
      return typeof field === 'number' ? field : null;
    }))
  };
}
