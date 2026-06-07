import { describe, it, expect } from 'vitest';
import { computeSheetStats, getStripHeight, calculateUtilization } from '$lib/nesting/stats';
import { bottomLeftFill } from '$lib/nesting/placement';
import type { Part, MaterialSheet } from '$lib/geometry/types';

function makePart(id: string, w: number, h: number): Part {
  return {
    id,
    name: id,
    polygons: [
      [
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: h },
        { x: 0, y: h },
      ],
    ],
    sourceIndex: 0,
  };
}

const sheet: MaterialSheet = { width: 100, height: 100 };

// Phase 0 is behavior-preserving: these assertions mirror the pre-extraction numbers
// (still bounding-box area). Slice B changes the area basis and updates these.
describe('getStripHeight (moved to stats.ts)', () => {
  it('returns 0 for empty placement', () => {
    expect(getStripHeight([])).toBe(0);
  });

  it('returns max Y of placed parts', () => {
    const placed = bottomLeftFill([{ part: makePart('a', 10, 20), rotation: 0 }], sheet);
    expect(getStripHeight(placed)).toBeCloseTo(20);
  });

  it('returns max Y across multiple parts', () => {
    const placed = bottomLeftFill(
      [
        { part: makePart('a', 10, 30), rotation: 0 },
        { part: makePart('b', 10, 10), rotation: 0 },
      ],
      sheet,
    );
    expect(getStripHeight(placed)).toBeCloseTo(30);
  });
});

describe('calculateUtilization (moved to stats.ts)', () => {
  it('returns 0 for empty placement', () => {
    expect(calculateUtilization([], sheet)).toBe(0);
  });

  it('returns correct utilization for known case', () => {
    const placed = bottomLeftFill([{ part: makePart('a', 50, 50), rotation: 0 }], sheet);
    // 50*50 part area / (50 strip height * 100 width) = 0.5
    expect(calculateUtilization(placed, sheet)).toBeCloseTo(0.5);
  });
});

describe('computeSheetStats (moved to stats.ts)', () => {
  it('returns zero stats for empty placement', () => {
    expect(computeSheetStats([], sheet)).toEqual({ stripHeight: 0, utilization: 0 });
  });

  it('returns strip height and utilization together', () => {
    const placed = bottomLeftFill([{ part: makePart('a', 50, 50), rotation: 0 }], sheet);
    const stats = computeSheetStats(placed, sheet);
    expect(stats.stripHeight).toBeCloseTo(50);
    expect(stats.utilization).toBeCloseTo(0.5);
  });
});
