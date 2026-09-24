import type { Path } from '@jsonjoy.com/json-pointer';
import { IHistoryValuesResponse } from '../services/history-api-client.service';
import { resolvePointer, splitPointerPath } from './pointer-path.util';

/** A configured path as a History API query, see {@link historyQueryTarget}. */
export interface IHistoryQueryTarget {
  /** The Signal K path the value lives at, as the delta stream addresses it. */
  basePath: string;
  /** `basePath` without its own-vessel `self.` prefix, as the History API addresses it. */
  historyPath: string;
  /** The field to extract from each row's object value, or null to graph the value itself. */
  pointer: Path | null;
}

/**
 * Splits a configured path, possibly `<path>#<pointer>`, into what a History API query needs. Null
 * when the pointer is malformed: it addresses nothing, the same as in a live widget.
 */
export function historyQueryTarget(path: string): IHistoryQueryTarget | null {
  const split = splitPointerPath(path);
  if (!split.valid) return null;
  return { basePath: split.basePath, historyPath: split.basePath.replace(/^(vessels\.)?self\./, ''), pointer: split.pointer };
}

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
