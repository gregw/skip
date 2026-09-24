import { describe, expect, it } from 'vitest';
import { resolvePointer, splitPointerPath } from './pointer-path.util';

const pointerOf = (path: string) => {
  const parsed = splitPointerPath(path);
  if (!parsed.valid || !parsed.pointer) {
    throw new Error(`expected a valid pointer path: ${path}`);
  }
  return parsed.pointer;
};

describe('splitPointerPath', () => {
  it('splits a path at "#" into the base path and pointer tokens', () => {
    expect(splitPointerPath('self.navigation.position#/latitude'))
      .toEqual({ valid: true, basePath: 'self.navigation.position', pointer: ['latitude'] });
  });

  it('passes a path without "#" through with no pointer', () => {
    expect(splitPointerPath('self.navigation.speedOverGround'))
      .toEqual({ valid: true, basePath: 'self.navigation.speedOverGround', pointer: null });
  });

  it('parses a multi-token pointer', () => {
    expect(pointerOf('self.a#/b/c/0')).toEqual(['b', 'c', '0']);
  });

  it('decodes ~01 to the key "~1", not "/"', () => {
    expect(pointerOf('self.a#/~01')).toEqual(['~1']);
  });

  it('trims the base path but not the pointer tokens', () => {
    // "#/ " addresses the key " " (RFC 6901 §5), so trimming it would change its meaning.
    expect(splitPointerPath(' self.a #/ '))
      .toEqual({ valid: true, basePath: 'self.a', pointer: [' '] });
  });

  it.each([
    { label: 'an empty pointer', path: 'self.a#' },
    { label: 'a pointer without a leading "/"', path: 'self.a#latitude' },
    { label: 'a second "#"', path: 'self.a##/a' },
    { label: '"~" followed by anything but 0 or 1', path: 'self.a#/a~2b' },
    { label: 'a trailing "~"', path: 'self.a#/a~' }
  ])('reports $label as invalid', ({ path }) => {
    expect(splitPointerPath(path)).toEqual({ valid: false, basePath: 'self.a' });
  });

  it.each([null, undefined])('reports an unset path (%s) as invalid instead of throwing', path => {
    expect(splitPointerPath(path)).toEqual({ valid: false, basePath: '' });
  });
});

describe('resolvePointer', () => {
  // RFC 6901 §5 example document.
  const rfcDocument = {
    foo: ['bar', 'baz'],
    '': 0,
    'a/b': 1,
    'c%d': 2,
    'e^f': 3,
    'g|h': 4,
    'i\\j': 5,
    'k"l': 6,
    ' ': 7,
    'm~n': 8
  };

  it.each([
    ['/foo', ['bar', 'baz']],
    ['/foo/0', 'bar'],
    ['/', 0],
    ['/a~1b', 1],
    ['/c%d', 2],
    ['/e^f', 3],
    ['/g|h', 4],
    ['/i\\j', 5],
    ['/k"l', 6],
    ['/ ', 7],
    ['/m~0n', 8]
  ])('resolves the RFC 6901 pointer %j', (pointer, expected) => {
    expect(resolvePointer(rfcDocument, pointerOf(`self.doc#${pointer}`))).toEqual(expected);
  });

  it('resolves a field of a Signal K object value', () => {
    const attitude = { roll: -0.0384, pitch: 0.0091, yaw: null };
    expect(resolvePointer(attitude, pointerOf('self.navigation.attitude#/roll'))).toBe(-0.0384);
    expect(resolvePointer(attitude, pointerOf('self.navigation.attitude#/yaw'))).toBeNull();
  });

  it.each(['/foo/01', '/foo/-', '/foo/2'])('resolves the array index %j to null', pointer => {
    expect(resolvePointer(rfcDocument, pointerOf(`self.doc#${pointer}`))).toBeNull();
  });

  it.each(['/constructor', '/toString', '/__proto__'])('resolves the inherited property %j to null', pointer => {
    expect(resolvePointer({ latitude: 60 }, pointerOf(`self.doc#${pointer}`))).toBeNull();
  });

  it('resolves a missing key to null', () => {
    expect(resolvePointer({ latitude: 60 }, pointerOf('self.navigation.position#/altitude'))).toBeNull();
  });

  it.each([
    { label: 'a number', value: 1.5 },
    { label: 'a string', value: 'latitude' },
    { label: 'null', value: null },
    { label: 'undefined', value: undefined }
  ])('resolves a pointer into $label to null', ({ value }) => {
    expect(resolvePointer(value, pointerOf('self.navigation.position#/latitude'))).toBeNull();
  });
});
