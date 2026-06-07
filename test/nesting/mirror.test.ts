import { describe, it, expect } from 'vitest';
import { reflectPolygon, getPlacedPolygons } from '$lib/geometry/polygon';
import type { Part, Polygon } from '$lib/geometry/types';

describe('reflectPolygon (#15)', () => {
  it('negates x (reflects across the vertical axis)', () => {
    const p: Polygon = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
    ];
    expect(reflectPolygon(p)).toEqual([
      { x: 0, y: 0 },
      { x: -2, y: 0 },
      { x: -2, y: 1 },
    ]);
  });
});

describe('getPlacedPolygons honors mirror (#15, exporters use this)', () => {
  const triangle: Part = {
    id: 't',
    name: 't',
    polygons: [
      [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 0, y: 1 },
      ],
    ],
    sourceIndex: 0,
  };

  it('places the un-mirrored part as-is at the origin', () => {
    const polys = getPlacedPolygons({ part: triangle, x: 0, y: 0, rotation: 0 });
    expect(polys[0]).toEqual([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 0, y: 1 },
    ]);
  });

  it('reflects the part when mirror is true (right angle flips sides)', () => {
    const polys = getPlacedPolygons({ part: triangle, x: 0, y: 0, rotation: 0, mirror: true });
    // reflect -> [(0,0),(-2,0),(0,1)] then normalize bbox-min to (0,0) -> shift +2 in x
    expect(polys[0]).toEqual([
      { x: 2, y: 0 },
      { x: 0, y: 0 },
      { x: 2, y: 1 },
    ]);
  });
});
