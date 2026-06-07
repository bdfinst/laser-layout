import { describe, it, expect } from 'vitest';
import { groupByContainment, removeCoincidentDuplicates } from '$lib/geometry/grouping';
import type { Part, Polygon } from '$lib/geometry/types';

function square(x: number, y: number, size: number): Polygon {
  return [
    { x, y },
    { x: x + size, y },
    { x: x + size, y: y + size },
    { x, y: y + size },
  ];
}

function part(id: string, polygons: Polygon[]): Part {
  return { id, name: id, polygons, sourceIndex: Number(id.replace(/\D/g, '')) || 0 };
}

describe('removeCoincidentDuplicates', () => {
  it('removes a shape that exactly overlaps another at the same position', () => {
    const a = part('p0', [square(10, 10, 50)]);
    const b = part('p1', [square(10, 10, 50)]); // coincident duplicate

    const result = removeCoincidentDuplicates([a, b]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p0'); // keeps the first occurrence
  });

  it('keeps identical shapes that sit at different positions', () => {
    const a = part('p0', [square(0, 0, 50)]);
    const b = part('p1', [square(100, 0, 50)]); // same shape, different place

    const result = removeCoincidentDuplicates([a, b]);

    expect(result).toHaveLength(2);
  });

  it('treats reversed-winding coincident shapes as duplicates', () => {
    const a = part('p0', [square(10, 10, 50)]);
    const b = part('p1', [[...square(10, 10, 50)].reverse()]);

    const result = removeCoincidentDuplicates([a, b]);

    expect(result).toHaveLength(1);
  });

  it('does not merge shapes that merely share a bounding box', () => {
    // Same bbox, different geometry (triangle vs square).
    const sq = part('p0', [square(0, 0, 100)]);
    const tri = part('p1', [
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
    ]);

    const result = removeCoincidentDuplicates([sq, tri]);

    expect(result).toHaveLength(2);
  });
});

describe('groupByContainment', () => {
  it('merges a fully-contained shape into its container as a cutout', () => {
    const outer = part('p0', [square(0, 0, 100)]);
    const inner = part('p1', [square(20, 20, 20)]);

    const grouped = groupByContainment([outer, inner]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0].polygons).toHaveLength(2);
    expect(grouped[0].polygons[0]).toEqual(square(0, 0, 100));
    expect(grouped[0].polygons[1]).toEqual(square(20, 20, 20));
  });

  it('keeps side-by-side shapes as separate parts', () => {
    const a = part('p0', [square(0, 0, 10)]);
    const b = part('p1', [square(50, 0, 10)]);

    const grouped = groupByContainment([a, b]);

    expect(grouped).toHaveLength(2);
    expect(grouped[0].polygons).toHaveLength(1);
    expect(grouped[1].polygons).toHaveLength(1);
  });

  it('attaches multiple cutouts to the same container', () => {
    const outer = part('p0', [square(0, 0, 100)]);
    const c1 = part('p1', [square(10, 10, 10)]);
    const c2 = part('p2', [square(40, 40, 10)]);
    const c3 = part('p3', [square(70, 70, 10)]);

    const grouped = groupByContainment([outer, c1, c2, c3]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0].polygons).toHaveLength(4);
  });

  it('treats an island inside a hole as its own part (laser-correct)', () => {
    const outer = part('p0', [square(0, 0, 100)]);
    const hole = part('p1', [square(10, 10, 80)]);
    const island = part('p2', [square(40, 40, 20)]);

    const grouped = groupByContainment([outer, hole, island]);

    expect(grouped).toHaveLength(2);
    const totalPolys = grouped.reduce((s, p) => s + p.polygons.length, 0);
    expect(totalPolys).toBe(3);
    const withHole = grouped.find((p) => p.polygons.length === 2)!;
    expect(withHole).toBeDefined();
    const islandPart = grouped.find((p) => p.polygons.length === 1)!;
    expect(islandPart.polygons[0]).toEqual(square(40, 40, 20));
  });

  it('preserves a part that already has cutouts (e.g. SVG subpaths)', () => {
    const compound = part('p0', [square(0, 0, 100), square(20, 20, 20)]);

    const grouped = groupByContainment([compound]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0].polygons).toHaveLength(2);
  });

  it('keeps the container part identity (id/name)', () => {
    const outer = part('panel', [square(0, 0, 100)]);
    const inner = part('hole', [square(20, 20, 20)]);

    const grouped = groupByContainment([outer, inner]);

    expect(grouped[0].name).toBe('panel');
  });
});
