import { describe, it, expect } from 'vitest';
import { dedupeCommonLineEdges } from '$lib/exporters/common-line';
import { exportToSVG } from '$lib/exporters/svg-exporter';
import { exportToLightBurn } from '$lib/exporters/lightburn-exporter';
import type { PlacedPart, Part } from '$lib/geometry/types';

function square(id: string, w: number, h: number): Part {
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

function placeAt(id: string, w: number, h: number, x: number, y: number): PlacedPart {
  return { part: square(id, w, h), rotation: 0, x, y };
}

describe('dedupeCommonLineEdges (#43)', () => {
  it('returns all four edges for a single square', () => {
    expect(dedupeCommonLineEdges([placeAt('a', 10, 10, 0, 0)])).toHaveLength(4);
  });

  it('emits the shared edge once for two abutting identical squares', () => {
    // Two squares sharing the vertical edge at x=10: 4 + 4 - 1 shared = 7 unique edges.
    const placed = [placeAt('a', 10, 10, 0, 0), placeAt('b', 10, 10, 10, 0)];
    expect(dedupeCommonLineEdges(placed)).toHaveLength(7);
  });

  it('keeps both edges when squares are separated (no coincident edge)', () => {
    const placed = [placeAt('a', 10, 10, 0, 0), placeAt('b', 10, 10, 12, 0)];
    expect(dedupeCommonLineEdges(placed)).toHaveLength(8);
  });

  it('collapses shared edges across a 2x2 block of squares', () => {
    // 4 squares, each 4 edges = 16; internal shared edges (2 vertical + 2 horizontal) each
    // counted once instead of twice → 16 - 4 = 12 unique edges.
    const placed = [
      placeAt('a', 10, 10, 0, 0),
      placeAt('b', 10, 10, 10, 0),
      placeAt('c', 10, 10, 0, 10),
      placeAt('d', 10, 10, 10, 10),
    ];
    expect(dedupeCommonLineEdges(placed)).toHaveLength(12);
  });
});

describe('exporters honor commonLineCutting (#43)', () => {
  const placed = [placeAt('a', 10, 10, 0, 0), placeAt('b', 10, 10, 10, 0)];
  const opts = { sheetWidth: 100, sheetHeight: 100 };

  it('SVG emits fewer path elements with common-line cutting on', () => {
    const off = exportToSVG(placed, opts);
    const on = exportToSVG(placed, { ...opts, commonLineCutting: true });
    // Off: two closed-part paths. On: 7 unique edge paths (one per deduped segment).
    const countPaths = (svg: string) => (svg.match(/<path /g) ?? []).length;
    expect(countPaths(off)).toBe(2);
    expect(countPaths(on)).toBe(7);
    expect(on).toContain('<svg');
  });

  it('LightBurn common-line output is valid XML with one merged path shape', () => {
    const on = exportToLightBurn(placed, { ...opts, commonLineCutting: true });
    expect(on).toContain('<LightBurnProject');
    // One merged Path shape plus the sheet Rect = the only two non-CutSetting shapes.
    const pathShapes = (on.match(/Type="Path"/g) ?? []).length;
    expect(pathShapes).toBe(1);
    // 7 unique edges → 7 line primitives in the merged shape.
    const prims = (on.match(/L\d+ \d+/g) ?? []).length;
    expect(prims).toBe(7);
  });

  it('default (off) export is unchanged — one path shape per part', () => {
    const off = exportToLightBurn(placed, opts);
    expect((off.match(/Type="Path"/g) ?? []).length).toBe(2);
  });
});
