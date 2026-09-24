import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import type { ISkPathData } from '../interfaces/app-interfaces';
import type { ISkMetadata } from '../interfaces/signalk-interfaces';
import { resolvePointer, splitPointerPath } from './pointer-path.util';

/**
 * Validator for a widget's Signal K path control.
 *
 * An empty value fails only when the slot is required — `pathRequired: false` on the sibling form
 * group marks a slot the user may leave blank. A non-empty value the server does not currently
 * publish is deliberately accepted: Signal K publishes a path only once some source has sent it, so
 * switching off the instrument behind an otherwise correct path makes it read as unknown, and
 * rejecting it would lock the widget's whole configuration until that gear comes back. Components
 * warn about such a path through {@link pathSlotWarning} instead of blocking Save.
 */
export const pathRequiredValidator: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
  const required = control.parent?.value?.pathRequired !== false;
  const value = control.value;
  return required && (value === null || value === '') ? { required: true } : null;
};

/**
 * Validator that blocks Save on a `path#pointer` whose pointer is malformed or that has no path
 * before `#`. Unlike an unpublished path, such a path can never resolve, whatever the server sends.
 */
export const pathPointerValidator: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
  const value = control.value;
  if (typeof value !== 'string' || !value.includes('#')) { return null; }
  const split = splitPointerPath(value);
  return split.valid && split.basePath ? null : { pointer: true };
};

/** What a widget slot demands of a path, mirroring the filters `DataService.getPathsAndMetaByType` applies. */
export interface IPathSlotRequirements {
  pathType: string;
  supportsPutOnly: boolean;
  zonesOnly: boolean;
  selfOnly: boolean;
}

// `getPathsAndMetaByType` matches these against the runtime type of the last received value, and
// anything else against `meta.type`.
const RUNTIME_TYPES = ['string', 'number', 'boolean', 'object', 'undefined', 'function', 'symbol', 'bigint', 'Date'];

const TYPE_WORDS: Record<string, { sends: string; needs: string; pick: string }> = {
  number: { sends: 'numeric', needs: 'a number', pick: 'numeric' },
  string: { sends: 'text', needs: 'text', pick: 'text' },
  boolean: { sends: 'true/false', needs: 'a true/false value', pick: 'true/false' },
  object: { sends: 'structured', needs: 'a structured value', pick: 'structured' },
  Date: { sends: 'date', needs: 'a date', pick: 'date' }
};

const typeWords = (type: string) => TYPE_WORDS[type] ?? { sends: type, needs: `a ${type} value`, pick: type };

const NOT_SENDING = 'Signal K is not sending this path. Check the spelling and the leading "self.", or keep it as-is if the instrument that sends it is switched off.';
const OTHER_VESSEL = 'This path belongs to another vessel, and "Restrict to own vessel" is on for this widget. Turn that off, or use a path starting with "self.".';
const NO_VALUE_YET = 'Signal K knows this path but has not sent a value yet, so its type cannot be checked. It should start working once data arrives.';
const NO_ZONES = 'This path has no alarm zones in its Signal K metadata, and this widget only offers paths that have them.';

/**
 * Why a configured path is not among the ones this slot offers, phrased for the user, or null when
 * the path is fine. A path missing from the slot's list has several quite different causes, and the
 * remedy differs for each — since an unrecognized path no longer blocks Save, this hint is the only
 * feedback the user gets. Resolve `pathObject` from the *unfiltered* store, so a path that exists
 * but fails one of the slot's filters can be told apart from one the server never sent.
 */
export function pathSlotWarning(
  path: string | null | undefined,
  pathObject: ISkPathData | null,
  requirements: IPathSlotRequirements,
  fieldMeta: ISkMetadata | null = null
): string | null {
  if (!path) { return null; }

  if (path.includes('#')) {
    return pointerSlotWarning(path, pathObject, requirements, fieldMeta);
  }

  if (!pathObject) {
    return NOT_SENDING;
  }

  if (requirements.selfOnly && !path.startsWith('self')) {
    return OTHER_VESSEL;
  }

  const wantsRuntimeType = RUNTIME_TYPES.includes(requirements.pathType);
  const actualType = wantsRuntimeType ? pathObject.type : pathObject.meta?.type;

  if (wantsRuntimeType && pathObject.type === undefined) {
    return NO_VALUE_YET;
  }

  if (actualType !== requirements.pathType) {
    return typeMismatch(actualType, requirements.pathType);
  }

  if (requirements.supportsPutOnly && pathObject.meta?.supportsPut !== true) {
    return 'This path is read-only. Signal K reports no PUT support for it, so this control cannot send commands to it.';
  }

  if (requirements.zonesOnly && !(pathObject.meta?.zones?.length)) {
    return NO_ZONES;
  }

  return null;
}

/**
 * The warning for a `path#pointer`, with `fieldMeta` the field's own metadata. Checks run from what
 * no data could fix to what the instrument might: a field can never take a command or carry zones,
 * then the base path must exist and be allowed, the field must be declared and of the slot's type,
 * and last the latest value must contain it. A malformed pointer is the validator's to report.
 */
function pointerSlotWarning(
  path: string,
  pathObject: ISkPathData | null,
  requirements: IPathSlotRequirements,
  fieldMeta: ISkMetadata | null
): string | null {
  const split = splitPointerPath(path);
  if (!split.valid || !split.pointer || !split.basePath) { return null; }

  if (requirements.supportsPutOnly) {
    return 'This control sends commands to a whole path and cannot target a single field. Pick a path without "#".';
  }
  if (requirements.zonesOnly) { return NO_ZONES; }
  if (!pathObject) { return NOT_SENDING; }
  if (requirements.selfOnly && !split.basePath.startsWith('self')) { return OTHER_VESSEL; }

  const fieldName = String(split.pointer[split.pointer.length - 1]);
  if (!fieldMeta) {
    return `Signal K does not list a field "${fieldName}" for this path. The widget will show nothing unless the value contains it.`;
  }

  const value = resolvePointer(pathObject.pathValue, split.pointer);
  const declaredType = fieldMeta.type === 'integer' ? 'number' : fieldMeta.type;
  const fieldType = declaredType ?? (value === null ? undefined : typeof value);
  if (fieldType !== undefined && fieldType !== requirements.pathType) {
    return typeMismatch(fieldType, requirements.pathType);
  }

  if (pathObject.type === undefined) { return NO_VALUE_YET; }
  if (value === null) {
    return `Signal K is sending this path, but its latest value has no "${fieldName}". The instrument may not report it.`;
  }
  return null;
}

function typeMismatch(actualType: string | undefined, wantedType: string): string {
  const sends = typeWords(actualType ?? 'unknown').sends;
  const wanted = typeWords(wantedType);
  return `This path sends ${sends} values, but this setting needs ${wanted.needs}. The widget will show nothing until you pick a ${wanted.pick} path.`;
}
