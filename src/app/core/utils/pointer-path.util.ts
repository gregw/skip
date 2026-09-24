import { get, parseJsonPointer, validateJsonPointer, type Path } from '@jsonjoy.com/json-pointer';

/**
 * A configured path split into the Signal K path it reads and, after `#`, the RFC 6901 pointer to
 * one field of that path's value. `pointer` is null for a plain path, which addresses the whole
 * value. An invalid result still carries the base path, so callers can explain the problem against
 * the path the user meant.
 */
export type PointerPath =
  | { valid: true; basePath: string; pointer: Path | null }
  | { valid: false; basePath: string };

// The library decodes only ~0 and ~1 and passes any other "~" through, which RFC 6901 forbids.
const STRAY_TILDE = /~(?![01])/;

/**
 * Split a configured path at its first `#` into the Signal K path and the parsed pointer. Signal K
 * paths never contain `#`. An empty pointer is invalid even though RFC 6901 allows it: the whole
 * value is already addressed by the path without `#`. Only the base path is trimmed, because `#/ `
 * addresses the key `" "`.
 */
export function splitPointerPath(path: string | null | undefined): PointerPath {
  // Slot paths come from stored widget config, where an unset path is null.
  if (typeof path !== 'string') {
    return { valid: false, basePath: '' };
  }
  const hash = path.indexOf('#');
  if (hash === -1) {
    return { valid: true, basePath: path.trim(), pointer: null };
  }

  const basePath = path.slice(0, hash).trim();
  const pointer = parsePointer(path.slice(hash + 1));
  return pointer ? { valid: true, basePath, pointer } : { valid: false, basePath };
}

/** The tokens of a non-empty RFC 6901 pointer such as `/roll`, or null when it is not one. */
export function parsePointer(pointer: string): Path | null {
  if (!pointer || STRAY_TILDE.test(pointer)) return null;
  try {
    validateJsonPointer(pointer);
  } catch {
    return null;
  }
  return parseJsonPointer(pointer);
}

/** The value `pointer` addresses inside `value`, or null when there is none. */
export function resolvePointer(value: unknown, pointer: Path): unknown {
  return get(value, pointer) ?? null;
}

/** The value type of a field whose metadata declares JSON Schema `type`: 'integer' is a 'number'. */
export function fieldValueType(type: string | undefined): string | undefined {
  return type === 'integer' ? 'number' : type;
}
