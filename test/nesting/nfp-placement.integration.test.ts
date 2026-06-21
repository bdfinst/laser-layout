import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseLightBurn } from '$lib/parsers/lightburn-parser';
import { groupByContainment, removeCoincidentDuplicates } from '$lib/geometry/grouping';
import { deduplicateParts } from '$lib/geometry/dedup';
import { nestParts } from '$lib/nesting/engine';
import { getPlacedPolygons } from '$lib/geometry/polygon';
import type { NestingConfig, Part, Point, Polygon } from '$lib/geometry/types';

// Exercises the opt-in NFP placement path (epic #24, P3–P5: candidate seats, compactness
// selection, NFP-clearance collision). The path is off by default; this turns it on and
// checks the contract that matters most — the placement is valid (parts don't overlap).

function orient(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function properCross(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const d1 = orient(b1, b2, a1);
  const d2 = orient(b1, b2, a2);
  const d3 = orient(a1, a2, b1);
  const d4 = orient(a1, a2, b2);
  const eps = 1e-6;
  const opp = (p: number, q: number) => (p > eps && q < -eps) || (p < -eps && q > eps);
  return opp(d1, d2) && opp(d3, d4);
}

function pointInPolygon(p: Point, poly: Polygon): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x,
      yi = poly[i].y,
      xj = poly[j].x,
      yj = poly[j].y;
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToBoundary(p: Point, poly: Polygon): number {
  let min = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    min = Math.min(min, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return min;
}

/** Positive-area overlap (penetration) between two simple polygons — touching is fine. */
function overlaps(A: Polygon, B: Polygon, eps: number): boolean {
  for (const p of A) if (pointInPolygon(p, B) && distToBoundary(p, B) > eps) return true;
  for (const p of B) if (pointInPolygon(p, A) && distToBoundary(p, A) > eps) return true;
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B.length; j++) {
      if (properCross(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length])) return true;
    }
  }
  return false;
}

function noOverlaps(result: ReturnType<typeof nestParts>, eps: number) {
  for (const sheet of result.sheets) {
    const outers = sheet.placed.map((pp) => getPlacedPolygons(pp)[0]);
    for (let i = 0; i < outers.length; i++) {
      for (let j = i + 1; j < outers.length; j++) {
        expect(overlaps(outers[i], outers[j], eps), `sheet parts ${i}/${j} overlap`).toBe(false);
      }
    }
  }
}

// Few-vertex concave parts: ≤10 vertices, so they are NOT simplified before nesting —
// the placed geometry equals the geometry the NFP collision reasoned over, giving a true
// no-overlap guarantee (lego's full-fidelity outlines differ from the simplified ones the
// collision uses, so that artifact would mask the property being tested).
function makePart(id: string, polygon: Polygon, i: number): Part {
  return { id, name: id, polygons: [polygon], sourceIndex: i };
}

const Lshape: Polygon = [
  { x: 0, y: 0 },
  { x: 60, y: 0 },
  { x: 60, y: 20 },
  { x: 20, y: 20 },
  { x: 20, y: 60 },
  { x: 0, y: 60 },
];
const Tshape: Polygon = [
  { x: 0, y: 0 },
  { x: 60, y: 0 },
  { x: 60, y: 20 },
  { x: 40, y: 20 },
  { x: 40, y: 55 },
  { x: 20, y: 55 },
  { x: 20, y: 20 },
  { x: 0, y: 20 },
];

describe('NFP placement path (epic #24, P3–P5, opt-in)', () => {
  it('nests concave parts with no overlaps when enabled', () => {
    const parts = [makePart('L', Lshape, 0), makePart('T', Tshape, 1)];
    const quantities = new Map([
      ['L', 4],
      ['T', 4],
    ]);
    const config: NestingConfig = {
      sheet: { width: 300, height: 300 },
      kerf: 1,
      rotationSteps: 72,
      populationSize: 20,
      generations: 30,
      useNfpPlacement: true,
    };
    const result = nestParts({ parts, quantities, config });
    expect(result.totalPlaced).toBe(8);
    expect(result.unplaced).toHaveLength(0);
    noOverlaps(result, 1e-6);
  });

  it('places every lego part (parity with the default path)', () => {
    const grouped = groupByContainment(
      removeCoincidentDuplicates(
        parseLightBurn(readFileSync(resolve('test-fixtures/lego-shelves.lbrn2'), 'utf-8')),
      ),
    );
    const { uniqueParts, quantities } = deduplicateParts(grouped);
    // A light budget — this checks feasibility/validity of the NFP path, not search
    // quality, so cap generations low to keep the (NFP-heavy) nest well under the timeout.
    const base: NestingConfig = {
      sheet: { width: 500, height: 500 },
      kerf: 1,
      rotationSteps: 72,
      populationSize: 20,
      generations: 8,
      maxGenerations: 10,
      useNfpPlacement: true,
    };
    const on = nestParts({ parts: uniqueParts, quantities, config: base });
    const off = nestParts({
      parts: uniqueParts,
      quantities,
      config: { ...base, useNfpPlacement: false },
    });
    expect(on.totalPlaced).toBe(12);
    expect(on.unplaced).toHaveLength(0);
    expect(off.totalPlaced).toBe(12);
  });
});
