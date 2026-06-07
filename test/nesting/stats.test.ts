import { describe, it, expect } from 'vitest';
import {
  computeSheetStats,
  getStripHeight,
  calculateUtilization,
  openAreaStats,
} from '$lib/nesting/stats';
import { bottomLeftFill } from '$lib/nesting/placement';
import { polygonArea, boundingBox } from '$lib/geometry/polygon';
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

// Part with an outer boundary and an interior cutout (square hole).
function makeHoledPart(id: string, w: number, h: number, hole: number): Part {
  const inset = (w - hole) / 2;
  const insetY = (h - hole) / 2;
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
      [
        { x: inset, y: insetY },
        { x: inset + hole, y: insetY },
        { x: inset + hole, y: insetY + hole },
        { x: inset, y: insetY + hole },
      ],
    ],
    sourceIndex: 0,
  };
}

const sheet: MaterialSheet = { width: 100, height: 100 };

// Slice B: utilization now uses true polygon area. Solid-rectangle fixtures are
// unchanged (true area == bbox area), so these baselines still hold.
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

describe('openAreaStats (true polygon area)', () => {
  it('returns a defined identity for empty placement (no NaN)', () => {
    const stats = openAreaStats([], sheet);
    expect(stats).toEqual({
      stripHeight: 0,
      partsArea: 0,
      usedArea: 0,
      openAreaRatio: 1,
      utilization: 0,
    });
    expect(Number.isNaN(stats.openAreaRatio)).toBe(false);
  });

  it('uses bbox area for a solid rectangle (true area == bbox area)', () => {
    const placed = bottomLeftFill([{ part: makePart('a', 50, 50), rotation: 0 }], sheet);
    const stats = openAreaStats(placed, sheet);
    expect(stats.partsArea).toBeCloseTo(2500);
    expect(stats.usedArea).toBeCloseTo(50 * 100);
    expect(stats.openAreaRatio).toBeCloseTo(0.5);
    expect(stats.utilization).toBeCloseTo(0.5);
  });

  it('subtracts cutout area for a holed part (outer minus cutout)', () => {
    const part = makeHoledPart('h', 60, 60, 20);
    const placed = bottomLeftFill([{ part, rotation: 0 }], sheet);
    const polys = part.polygons;
    const outerArea = polygonArea(polys[0]);
    const cutoutArea = polygonArea(polys[1]);
    const bbox = boundingBox(polys[0]);
    const bboxArea = bbox.width * bbox.height;

    const stats = openAreaStats(placed, sheet);

    // true area: outer minus cutout
    expect(stats.partsArea).toBeCloseTo(outerArea - cutoutArea);
    // strictly less than outer area
    expect(stats.partsArea).toBeLessThan(outerArea);
    // strictly less than bbox area (this is what a naive flat-sum impl gets wrong)
    expect(stats.partsArea).toBeLessThan(bboxArea);
  });

  it('keeps openAreaRatio within [0,1] and utilization == 1 - openAreaRatio', () => {
    const placed = bottomLeftFill(
      [
        { part: makeHoledPart('h', 60, 60, 20), rotation: 0 },
        { part: makePart('b', 20, 20), rotation: 0 },
      ],
      sheet,
    );
    const stats = openAreaStats(placed, sheet);
    expect(stats.openAreaRatio).toBeGreaterThanOrEqual(0);
    expect(stats.openAreaRatio).toBeLessThanOrEqual(1);
    expect(stats.utilization).toBeCloseTo(1 - stats.openAreaRatio);
  });
});
