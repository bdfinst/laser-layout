import { describe, it, expect } from 'vitest';
import { polygonsCloserThan } from '$lib/nesting/nfp';
import type { Polygon } from '$lib/geometry/types';

const sq = (x: number, y: number, s = 1): Polygon => [
  { x, y },
  { x: x + s, y },
  { x: x + s, y: y + s },
  { x, y: y + s },
];

describe('polygonsCloserThan (#11 true-shape spacing)', () => {
  it('detects a gap smaller than the threshold', () => {
    const a = sq(0, 0);
    const b = sq(3, 0); // 2 units apart (right edge of a at x=1, left of b at x=3)
    expect(polygonsCloserThan(a, b, 1)).toBe(false); // 2 >= 1, not closer than 1
    expect(polygonsCloserThan(a, b, 3)).toBe(true); // 2 < 3, closer than 3
  });

  it('treats touching polygons as closer than any positive distance', () => {
    const a = sq(0, 0);
    const b = sq(1, 0); // edges touch at x=1, distance 0
    expect(polygonsCloserThan(a, b, 0.5)).toBe(true);
  });

  it('treats one polygon inside another as overlapping (containment)', () => {
    const outer = sq(0, 0, 10);
    const inner = sq(3, 3, 2);
    expect(polygonsCloserThan(outer, inner, 0.001)).toBe(true);
  });

  it('allows exactly-threshold spacing (strict less-than)', () => {
    const a = sq(0, 0);
    const b = sq(2, 0); // gap is exactly 1 (right of a at 1, left of b at 2)
    expect(polygonsCloserThan(a, b, 1)).toBe(false); // distance == 1, not < 1
  });
});
