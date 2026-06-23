import { describe, it, expect } from 'vitest';
import { feasibleVertices, type IfpRect } from '$lib/nesting/nfp-feasible';
import type { Point, Polygon } from '$lib/geometry/types';
import { pointInPolygon } from '$lib/nesting/nfp';

const IFP: IfpRect = { x0: 0, y0: 0, x1: 200, y1: 200 };

function square(x: number, y: number, w: number, h: number): Polygon {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

function has(verts: Point[], x: number, y: number, tol = 0.5): boolean {
  return verts.some((v) => Math.abs(v.x - x) < tol && Math.abs(v.y - y) < tol);
}

describe('feasibleVertices', () => {
  it('returns the IFP rectangle corners when nothing is forbidden', () => {
    const v = feasibleVertices([], IFP, 0);
    expect(v).toHaveLength(4);
    expect(has(v, 0, 0)).toBe(true);
    expect(has(v, 200, 0)).toBe(true);
    expect(has(v, 0, 200)).toBe(true);
    expect(has(v, 200, 200)).toBe(true);
  });

  it('returns the corners of a single forbidden square as touching seats', () => {
    const v = feasibleVertices([square(50, 50, 60, 60)], IFP, 0);
    // The four corners of the forbidden region are exact touching positions.
    expect(has(v, 50, 50)).toBe(true);
    expect(has(v, 110, 50)).toBe(true);
    expect(has(v, 50, 110)).toBe(true);
    expect(has(v, 110, 110)).toBe(true);
  });

  it('exposes the two-contact reflex seat of a union of two overlapping squares', () => {
    // A and B overlap; their union is an L whose concave corners (110,90) and (90,110) are
    // vertices of NEITHER square alone — the interlocking seats the anchor path cannot make.
    const A = square(50, 50, 60, 60); // 50..110
    const B = square(90, 90, 60, 60); // 90..150
    const v = feasibleVertices([A, B], IFP, 0);
    expect(has(v, 110, 90)).toBe(true);
    expect(has(v, 90, 110)).toBe(true);
  });

  it('pushes candidates kerf away from the forbidden region', () => {
    const v = feasibleVertices([square(50, 50, 60, 60)], IFP, 2);
    // With kerf 2 the left clearance edge sits at x = 48 (50 − kerf), not 50.
    expect(v.some((p) => Math.abs(p.x - 48) < 0.6)).toBe(true);
    // And the bottom clearance edge at y = 48.
    expect(v.some((p) => Math.abs(p.y - 48) < 0.6)).toBe(true);
    expect(v.every((p) => p.x >= -1e-6 && p.y >= -1e-6)).toBe(true);
  });

  it('returns no candidates when the forbidden region fills the IFP', () => {
    // A forbidden square covering the whole inner-fit rectangle leaves nowhere to seat.
    const v = feasibleVertices([square(-10, -10, 220, 220)], IFP, 0);
    expect(v).toHaveLength(0);
  });

  it('keeps every candidate inside the IFP and outside the forbidden interior', () => {
    const forbidden = [square(40, 40, 50, 50), square(120, 30, 40, 90)];
    const v = feasibleVertices(forbidden, IFP, 0);
    expect(v.length).toBeGreaterThan(0);
    for (const p of v) {
      expect(p.x).toBeGreaterThanOrEqual(-0.01);
      expect(p.y).toBeGreaterThanOrEqual(-0.01);
      expect(p.x).toBeLessThanOrEqual(200.01);
      expect(p.y).toBeLessThanOrEqual(200.01);
      // No candidate sits strictly inside a forbidden square. Test against each square inset
      // by 1 mm so touching-boundary vertices (where ray-casting is numerically ambiguous)
      // don't false-trip — a strictly-interior candidate would still be inside the inset.
      for (const f of forbidden) {
        const inset: Polygon = [
          { x: f[0].x + 1, y: f[0].y + 1 },
          { x: f[1].x - 1, y: f[1].y + 1 },
          { x: f[2].x - 1, y: f[2].y - 1 },
          { x: f[3].x + 1, y: f[3].y - 1 },
        ];
        expect(pointInPolygon(p, inset)).toBe(false);
      }
    }
  });
});
