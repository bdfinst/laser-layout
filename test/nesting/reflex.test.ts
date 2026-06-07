import { describe, it, expect } from 'vitest';
import { reflexVertices } from '$lib/nesting/nfp';
import type { Polygon } from '$lib/geometry/types';

describe('reflexVertices (#12 concavity anchors)', () => {
  it('returns no reflex vertices for a convex polygon', () => {
    const square: Polygon = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
    ];
    expect(reflexVertices(square)).toHaveLength(0);
  });

  it('finds the single inner corner of an L-shape (CCW)', () => {
    // L-shape; the reflex (concave) vertex is the inner corner at (1,1).
    const ell: Polygon = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 0, y: 2 },
    ];
    const reflex = reflexVertices(ell);
    expect(reflex).toHaveLength(1);
    expect(reflex[0]).toEqual({ x: 1, y: 1 });
  });

  it('is winding-independent (same reflex corner for CW order)', () => {
    const ellCW: Polygon = [
      { x: 0, y: 0 },
      { x: 0, y: 2 },
      { x: 1, y: 2 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 2, y: 0 },
    ];
    const reflex = reflexVertices(ellCW);
    expect(reflex).toHaveLength(1);
    expect(reflex[0]).toEqual({ x: 1, y: 1 });
  });
});
