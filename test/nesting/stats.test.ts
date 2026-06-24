import { describe, it, expect } from 'vitest';
import {
  computeSheetStats,
  getStripHeight,
  calculateUtilization,
  openAreaStats,
  gravityMetric,
  remnantStats,
  sharedEdgeLength,
  sharedEdgeRatio,
} from '$lib/nesting/stats';
import { bottomLeftFill } from '$lib/nesting/placement';
import type { PlacedPart } from '$lib/geometry/types';
import { polygonArea, boundingBox } from '$lib/geometry/polygon';
import { makeRect as makePart } from '../support/parts';
import type { Part, MaterialSheet } from '$lib/geometry/types';

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

// Place a single part at an explicit position (bypasses bottom-left-fill so fixtures can
// put a part anywhere on the sheet).
function placeAt(id: string, w: number, h: number, x: number, y: number): PlacedPart {
  return { part: makePart(id, w, h), rotation: 0, x, y };
}

describe('gravityMetric (#41 compactness)', () => {
  it('returns 0 for an empty placement (nothing to pull)', () => {
    expect(gravityMetric([], sheet)).toBe(0);
  });

  it('is smaller when a part hugs the origin corner than when it sits far from it', () => {
    const corner = gravityMetric([placeAt('a', 10, 10, 0, 0)], sheet);
    const far = gravityMetric([placeAt('a', 10, 10, 80, 80)], sheet);
    expect(corner).toBeLessThan(far);
    expect(corner).toBeGreaterThanOrEqual(0);
    expect(far).toBeLessThanOrEqual(1);
  });

  it('is smaller for a clustered pack than for the same parts scattered apart', () => {
    const clustered = gravityMetric(
      [placeAt('a', 10, 10, 0, 0), placeAt('b', 10, 10, 10, 0)],
      sheet,
    );
    const scattered = gravityMetric(
      [placeAt('a', 10, 10, 0, 0), placeAt('b', 10, 10, 80, 80)],
      sheet,
    );
    expect(clustered).toBeLessThan(scattered);
  });
});

describe('remnantStats (#41 largest reusable offcut)', () => {
  it('returns the whole sheet (ratio 1) for an empty placement', () => {
    const r = remnantStats([], sheet);
    expect(r.largestRectRatio).toBeCloseTo(1, 5);
    expect(r.largestRectArea).toBeCloseTo(sheet.width * sheet.height, 0);
  });

  it('returns zero for a non-positive sheet area', () => {
    expect(remnantStats([], { width: 0, height: 100 })).toEqual({
      largestRectArea: 0,
      largestRectRatio: 0,
    });
  });

  it('leaves a large contiguous remnant when one part sits in a corner', () => {
    const r = remnantStats([placeAt('a', 30, 30, 0, 0)], sheet);
    // A 30x30 corner part leaves a clean L-shaped offcut; the largest empty rectangle is
    // ~70% of the sheet width (or height) by full extent — comfortably over half the sheet.
    expect(r.largestRectRatio).toBeGreaterThan(0.6);
  });

  it('rewards a clustered pack over a scattered one (bigger contiguous offcut)', () => {
    const clustered = remnantStats(
      [placeAt('a', 30, 30, 0, 0), placeAt('b', 30, 30, 30, 0)],
      sheet,
    );
    const scattered = remnantStats(
      [placeAt('a', 30, 30, 0, 0), placeAt('b', 30, 30, 70, 70)],
      sheet,
    );
    expect(clustered.largestRectRatio).toBeGreaterThan(scattered.largestRectRatio);
  });

  it('keeps largestRectRatio within [0,1]', () => {
    const r = remnantStats([placeAt('a', 50, 50, 10, 10)], sheet);
    expect(r.largestRectRatio).toBeGreaterThanOrEqual(0);
    expect(r.largestRectRatio).toBeLessThanOrEqual(1);
  });
});

describe('sharedEdgeLength / sharedEdgeRatio (#43 common-line cutting)', () => {
  it('returns 0 for fewer than two parts', () => {
    expect(sharedEdgeLength([])).toBe(0);
    expect(sharedEdgeLength([placeAt('a', 10, 10, 0, 0)])).toBe(0);
  });

  it('measures the full shared edge between two abutting identical squares', () => {
    // b sits immediately to the right of a; they share the full 10mm vertical edge at x=10.
    const placed = [placeAt('a', 10, 10, 0, 0), placeAt('b', 10, 10, 10, 0)];
    expect(sharedEdgeLength(placed)).toBeCloseTo(10, 6);
  });

  it('measures only the overlapping span when abutting parts are offset', () => {
    // b is shifted up 4mm, so only 6mm of the vertical edge at x=10 is shared.
    const placed = [placeAt('a', 10, 10, 0, 0), placeAt('b', 10, 10, 10, 4)];
    expect(sharedEdgeLength(placed)).toBeCloseTo(6, 6);
  });

  it('is 0 when parts are separated by a gap (no coincident edges)', () => {
    const placed = [placeAt('a', 10, 10, 0, 0), placeAt('b', 10, 10, 12, 0)];
    expect(sharedEdgeLength(placed)).toBe(0);
  });

  it('sums shared edges across a row of three abutting squares', () => {
    // a|b and b|c each share a 10mm edge → 20mm total.
    const placed = [
      placeAt('a', 10, 10, 0, 0),
      placeAt('b', 10, 10, 10, 0),
      placeAt('c', 10, 10, 20, 0),
    ];
    expect(sharedEdgeLength(placed)).toBeCloseTo(20, 6);
  });

  it('normalizes the ratio into [0,1], higher for more sharing', () => {
    const touching = sharedEdgeRatio([placeAt('a', 10, 10, 0, 0), placeAt('b', 10, 10, 10, 0)]);
    const apart = sharedEdgeRatio([placeAt('a', 10, 10, 0, 0), placeAt('b', 10, 10, 12, 0)]);
    expect(touching).toBeGreaterThan(apart);
    expect(apart).toBe(0);
    expect(touching).toBeGreaterThan(0);
    expect(touching).toBeLessThanOrEqual(1);
  });
});
