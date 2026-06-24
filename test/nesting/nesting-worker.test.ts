import { describe, it, expect } from 'vitest';
import { rehydrateQuantities } from '$lib/nesting/nesting-worker';

describe('rehydrateQuantities', () => {
  it('returns a Map input as an equal copy, not the same reference', () => {
    const input = new Map<string, number>([
      ['a', 2],
      ['b', 5],
    ]);
    const result = rehydrateQuantities(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });

  it('turns an array of [id, count] pairs into a map', () => {
    const result = rehydrateQuantities([
      ['a', 2],
      ['b', 5],
    ]);
    expect(result).toEqual(
      new Map([
        ['a', 2],
        ['b', 5],
      ]),
    );
  });

  it('turns a plain object into a map', () => {
    const result = rehydrateQuantities({ a: 2, b: 5 });
    expect(result).toEqual(
      new Map([
        ['a', 2],
        ['b', 5],
      ]),
    );
  });

  it('coerces numeric-string object values to numbers', () => {
    const result = rehydrateQuantities({ a: '2', b: '5' });
    expect(result.get('a')).toBe(2);
    expect(result.get('b')).toBe(5);
  });

  it('coerces a non-numeric object value verbatim to NaN (pinned, not fixed)', () => {
    const result = rehydrateQuantities({ a: 'abc' });
    expect(result.get('a')).toBeNaN();
  });

  it('yields an empty map for empty Map, array, or object inputs', () => {
    expect(rehydrateQuantities(new Map())).toEqual(new Map());
    expect(rehydrateQuantities([])).toEqual(new Map());
    expect(rehydrateQuantities({})).toEqual(new Map());
  });
});
