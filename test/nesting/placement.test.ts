import { describe, it, expect } from 'vitest';
import { bottomLeftFill } from '$lib/nesting/placement';
import { createNfpCache } from '$lib/nesting/nfp-cache';
import { getPlacedPolygons, boundingBox } from '$lib/geometry/polygon';
import { polygonsOverlap, polygonsCloserThan } from '$lib/nesting/nfp';
import { makeRect as makePart } from '../support/parts';
import type { Part, MaterialSheet, PlacedPart } from '$lib/geometry/types';

function makePartWithHole(
  id: string,
  outerW: number,
  outerH: number,
  holeX: number,
  holeY: number,
  holeW: number,
  holeH: number,
): Part {
  return {
    id,
    name: id,
    polygons: [
      [
        { x: 0, y: 0 },
        { x: outerW, y: 0 },
        { x: outerW, y: outerH },
        { x: 0, y: outerH },
      ],
      [
        { x: holeX, y: holeY },
        { x: holeX + holeW, y: holeY },
        { x: holeX + holeW, y: holeY + holeH },
        { x: holeX, y: holeY + holeH },
      ],
    ],
    sourceIndex: 0,
  };
}

const sheet: MaterialSheet = { width: 100, height: 100 };

describe('bottomLeftFill', () => {
  it('places a single part at origin', () => {
    const result = bottomLeftFill([{ part: makePart('a', 10, 10), rotation: 0 }], sheet);
    expect(result).toHaveLength(1);
    expect(result[0].x).toBeCloseTo(0);
    expect(result[0].y).toBeCloseTo(0);
  });

  it('places two non-overlapping parts', () => {
    const result = bottomLeftFill(
      [
        { part: makePart('a', 10, 10), rotation: 0 },
        { part: makePart('b', 10, 10), rotation: 0 },
      ],
      sheet,
    );
    expect(result).toHaveLength(2);
    const [p1, p2] = result;
    const overlap = p1.x < p2.x + 10 && p1.x + 10 > p2.x && p1.y < p2.y + 10 && p1.y + 10 > p2.y;
    expect(overlap).toBe(false);
  });

  it('respects kerf spacing', () => {
    const result = bottomLeftFill(
      [
        { part: makePart('a', 10, 10), rotation: 0 },
        { part: makePart('b', 10, 10), rotation: 0 },
      ],
      sheet,
      5,
    );
    expect(result).toHaveLength(2);
    const [p1, p2] = result;
    const gapX = Math.max(p2.x - (p1.x + 10), p1.x - (p2.x + 10));
    const gapY = Math.max(p2.y - (p1.y + 10), p1.y - (p2.y + 10));
    expect(Math.max(gapX, gapY)).toBeGreaterThanOrEqual(4.99);
  });

  it('skips parts that do not fit', () => {
    expect(bottomLeftFill([{ part: makePart('huge', 200, 200), rotation: 0 }], sheet)).toHaveLength(
      0,
    );
  });

  it('places multiple parts filling the sheet', () => {
    const parts = Array.from({ length: 10 }, (_, i) => ({
      part: makePart(`p${i}`, 10, 10),
      rotation: 0,
    }));
    expect(bottomLeftFill(parts, sheet)).toHaveLength(10);
  });

  it('rescues a part that only fits when rotated 90° (density/NFP path)', () => {
    // 200×40 part cannot fit a 100×300 sheet at rotation 0 (200 > 100 wide), but fits when
    // turned to 40×200. The density path retries +90° as a rescue when the gene rotation
    // fails to place.
    const tall: MaterialSheet = { width: 100, height: 300 };
    const cache = createNfpCache();
    const result = bottomLeftFill(
      [{ part: makePart('wide', 200, 40), rotation: 0 }],
      tall,
      1,
      true,
      cache,
    );
    expect(result).toHaveLength(1);
    expect(result[0].rotation).toBeCloseTo(Math.PI / 2, 5);
  });

  it('does NOT rescue-rotate on the fast (non-NFP) path — fast path unchanged', () => {
    const tall: MaterialSheet = { width: 100, height: 300 };
    // No NFP cache ⇒ fast path; a 200×40 part stays at rotation 0 and cannot be placed.
    const result = bottomLeftFill(
      [{ part: makePart('wide', 200, 40), rotation: 0 }],
      tall,
      1,
      true,
    );
    expect(result).toHaveLength(0);
  });
});

describe('hole-aware placement', () => {
  it('places a small part inside a large part hole', () => {
    // Hole at (5,5) size 40x40 — large enough that all candidates are strictly interior
    const ring = makePartWithHole('ring', 50, 50, 5, 5, 40, 40);
    const small = makePart('small', 10, 10);
    const result = bottomLeftFill(
      [
        { part: ring, rotation: 0 },
        { part: small, rotation: 0 },
      ],
      sheet,
    );
    expect(result).toHaveLength(2);
    const sp = result[1];
    expect(sp.x).toBeGreaterThanOrEqual(5);
    expect(sp.y).toBeGreaterThanOrEqual(5);
    expect(sp.x + 10).toBeLessThanOrEqual(45);
    expect(sp.y + 10).toBeLessThanOrEqual(45);
  });

  it('does not place a part too large for the hole inside it', () => {
    // 20x20 hole, 25x25 part — rejected by BB pre-filter
    const ring = makePartWithHole('ring', 50, 50, 15, 15, 20, 20);
    const big = makePart('big', 25, 25);
    const result = bottomLeftFill(
      [
        { part: ring, rotation: 0 },
        { part: big, rotation: 0 },
      ],
      sheet,
    );
    expect(result).toHaveLength(2);
    const bp = result[1];
    const insideHole = bp.x >= 15 && bp.y >= 15 && bp.x + 25 <= 35 && bp.y + 25 <= 35;
    expect(insideHole).toBe(false);
  });

  it('rejects a part that fits in hole BB but not after kerf inset', () => {
    // 20x20 hole with kerf=1 → inset to ~18x18. A 19x19 part fits the hole BB
    // but not the inset BB, exercising the kerf-aware rejection.
    const ring = makePartWithHole('ring', 50, 50, 15, 15, 20, 20);
    const nearFit = makePart('nearfit', 19, 19);
    const result = bottomLeftFill(
      [
        { part: ring, rotation: 0 },
        { part: nearFit, rotation: 0 },
      ],
      sheet,
      1,
    );
    expect(result).toHaveLength(2);
    const nf = result[1];
    const insideHole = nf.x >= 15 && nf.y >= 15 && nf.x + 19 <= 35 && nf.y + 19 <= 35;
    expect(insideHole).toBe(false);
  });

  it('respects kerf spacing inside holes', () => {
    // 30x30 hole with kerf=2, inset to ~26x26. Place two 12x12 parts — both fit.
    // Then try a 14x14 — should NOT fit alongside a 12x12 in the 26x26 space.
    const ring = makePartWithHole('ring', 60, 60, 15, 15, 30, 30);
    const first = makePart('first', 12, 12);
    const second = makePart('second', 14, 14);
    const result = bottomLeftFill(
      [
        { part: ring, rotation: 0 },
        { part: first, rotation: 0 },
        { part: second, rotation: 0 },
      ],
      sheet,
      2,
    );
    expect(result).toHaveLength(3);
    // First should be inside the hole
    const fp = result[1];
    expect(fp.x).toBeGreaterThanOrEqual(15);
    expect(fp.y).toBeGreaterThanOrEqual(15);
    // Second should be on the sheet (kerf collision with first inside hole)
    const sp = result[2];
    const secondInsideHole = sp.x >= 15 && sp.y >= 15 && sp.x + 14 <= 45 && sp.y + 14 <= 45;
    expect(secondInsideHole).toBe(false);
  });

  it('places multiple small parts inside a single hole', () => {
    const frame = makePartWithHole('frame', 60, 60, 5, 5, 50, 50);
    const tiles = Array.from({ length: 4 }, (_, i) => ({
      part: makePart(`tile${i}`, 15, 15),
      rotation: 0,
    }));
    const result = bottomLeftFill([{ part: frame, rotation: 0 }, ...tiles], sheet);
    const tilesInHole = result.filter(
      (pp) =>
        pp.part.id.startsWith('tile') &&
        pp.x >= 5 &&
        pp.y >= 5 &&
        pp.x + 15 <= 55 &&
        pp.y + 15 <= 55,
    );
    expect(tilesInHole.length).toBeGreaterThanOrEqual(2);
  });

  it('does not nest parts inside holes of hole-placed parts (no recursive nesting)', () => {
    const frame = makePartWithHole('frame', 60, 60, 10, 10, 40, 40);
    const medium = makePartWithHole('medium', 30, 30, 5, 5, 20, 20);
    const tiny = makePart('tiny', 5, 5);

    const result = bottomLeftFill(
      [
        { part: frame, rotation: 0 },
        { part: medium, rotation: 0 },
        { part: tiny, rotation: 0 },
      ],
      sheet,
    );
    expect(result).toHaveLength(3);

    const mediumPlaced = result.find((pp) => pp.part.id === 'medium')!;
    const tinyPlaced = result.find((pp) => pp.part.id === 'tiny')!;

    // Medium should be fully inside frame's hole (10,10)-(50,50)
    expect(mediumPlaced.x).toBeGreaterThanOrEqual(10);
    expect(mediumPlaced.y).toBeGreaterThanOrEqual(10);
    expect(mediumPlaced.x + 30).toBeLessThanOrEqual(50);
    expect(mediumPlaced.y + 30).toBeLessThanOrEqual(50);

    // Tiny should NOT be inside medium's hole (no recursive nesting)
    const mhx = mediumPlaced.x + 5;
    const mhy = mediumPlaced.y + 5;
    const tinyInsideMediumHole =
      tinyPlaced.x >= mhx &&
      tinyPlaced.y >= mhy &&
      tinyPlaced.x + 5 <= mhx + 20 &&
      tinyPlaced.y + 5 <= mhy + 20;
    expect(tinyInsideMediumHole).toBe(false);

    // Tiny should be placed somewhere valid (on sheet or in frame's remaining hole space)
    expect(tinyPlaced.x).toBeGreaterThanOrEqual(0);
    expect(tinyPlaced.y).toBeGreaterThanOrEqual(0);
  });

  it('parts without holes nest as before', () => {
    const parts = [
      { part: makePart('a', 20, 20), rotation: 0 },
      { part: makePart('b', 20, 20), rotation: 0 },
    ];
    const result = bottomLeftFill(parts, sheet);
    expect(result).toHaveLength(2);
    expect(result[0].x).toBeCloseTo(0);
    expect(result[0].y).toBeCloseTo(0);
  });
});

describe('gap-filling placement', () => {
  // Coarse-step slide granularity is step = max(1, min(partW, partH) / 4).
  // For the 20x50 filler below that is max(1, 20/4) = 5, so all fixture
  // coordinates are multiples of 5 and the pocket floor is reachable.

  it('tucks a part into an interior gap instead of a higher corner (concrete fixture)', () => {
    // A wide sheet so corners exist; H tall so strip height has room to grow.
    const gapSheet: MaterialSheet = { width: 100, height: 200 };

    // Deterministic layout (verified against the placement model):
    //   A 30x40 -> (0,0)-(30,40)
    //   B 60x10 -> (30,0)-(90,10)
    //   C 20x30 -> (30,10)-(50,40)
    //   D 60x60 -> (0,40)-(60,100)
    // This leaves an interior pocket to the right of C / above B at x in [60,90],
    // y in [10,40] (floor = top of B at y=10). The only corner anchor the legacy
    // engine reaches for the next part sits at y=40 (to the right of D), which is
    // strictly higher than the pocket floor.
    const filler = makePart('filler', 20, 50); // fits the pocket width (20) and slides to y=10
    const parts = [
      { part: makePart('A', 30, 40), rotation: 0 },
      { part: makePart('B', 60, 10), rotation: 0 },
      { part: makePart('C', 20, 30), rotation: 0 },
      { part: makePart('D', 60, 60), rotation: 0 },
      { part: filler, rotation: 0 },
    ];

    const result = bottomLeftFill(parts, gapSheet);
    expect(result).toHaveLength(5);

    const stripBeforeFiller = Math.max(
      ...result.slice(0, 4).map((pp) => pp.y + boundingBox(getPlacedPolygons(pp)[0]).height),
    );
    const fillerPlaced = result[4];

    // The filler is tucked into the low interior pocket, not the y=40 corner.
    expect(fillerPlaced.y).toBeCloseTo(10);

    // And it does not raise the overall strip height.
    const stripAfter = Math.max(
      ...result.map((pp) => pp.y + boundingBox(getPlacedPolygons(pp)[0]).height),
    );
    expect(stripAfter).toBeLessThanOrEqual(stripBeforeFiller + 1e-6);
  });

  // (b) Property-style, parameterized by kerf.
  const partSets: { name: string; dims: [number, number][] }[] = [
    {
      name: 'mixed small',
      dims: [
        [30, 40],
        [60, 10],
        [20, 30],
        [60, 60],
        [20, 50],
      ],
    },
    {
      name: 'uniform squares',
      dims: Array.from({ length: 9 }, () => [20, 20] as [number, number]),
    },
    {
      name: 'tall and wide mix',
      dims: [
        [10, 50],
        [50, 10],
        [30, 30],
        [40, 20],
        [20, 40],
        [10, 10],
      ],
    },
    {
      name: 'descending widths',
      dims: [
        [60, 20],
        [50, 20],
        [40, 20],
        [30, 20],
        [20, 20],
      ],
    },
  ];

  for (const { name, dims } of partSets) {
    for (const kerf of [0, 3]) {
      it(`no invalid placements for "${name}" at kerf=${kerf} (A3)`, () => {
        const propSheet: MaterialSheet = { width: 120, height: 240 };
        const parts = dims.map(([w, h], i) => ({
          part: makePart(`${name}-${i}`, w, h),
          rotation: 0,
        }));
        const result = bottomLeftFill(parts, propSheet, kerf);

        // Every placed part is fully within the sheet.
        for (const pp of result) {
          const bb = boundingBox(getPlacedPolygons(pp)[0]);
          expect(bb.minX).toBeGreaterThanOrEqual(-1e-6);
          expect(bb.minY).toBeGreaterThanOrEqual(-1e-6);
          expect(bb.maxX).toBeLessThanOrEqual(propSheet.width + 1e-6);
          expect(bb.maxY).toBeLessThanOrEqual(propSheet.height + 1e-6);
        }

        for (let i = 0; i < result.length; i++) {
          for (let j = i + 1; j < result.length; j++) {
            const a = result[i] as PlacedPart;
            const b = result[j] as PlacedPart;
            if (kerf === 0) {
              // No two placed polygons overlap (bbox overlap is permitted). Check ALL
              // polygon pairs across both parts, not just the outer boundaries, so an
              // inner-ring-vs-outer overlap on holed parts can't slip through.
              for (const pa of getPlacedPolygons(a)) {
                for (const pb of getPlacedPolygons(b)) {
                  expect(polygonsOverlap(pa, pb)).toBe(false);
                }
              }
            } else {
              // True-shape spacing (#11): outlines must be >= kerf apart. Bounding boxes
              // may now be closer than kerf (that is the point), so assert on the real
              // polygon distance, not the bbox.
              expect(
                polygonsCloserThan(getPlacedPolygons(a)[0], getPlacedPolygons(b)[0], kerf - 1e-6),
              ).toBe(false);
            }
          }
        }
      });
    }
  }

  // (c) Hole placement remains highest priority.
  it('hole placement still wins over gap filling when a hole fits', () => {
    const ring = makePartWithHole('ring', 50, 50, 5, 5, 40, 40);
    const small = makePart('small', 10, 10);
    const result = bottomLeftFill(
      [
        { part: ring, rotation: 0 },
        { part: small, rotation: 0 },
      ],
      sheet,
    );
    expect(result).toHaveLength(2);
    const sp = result[1];
    // Placed inside the ring's hole, not slid into some exterior gap.
    expect(sp.x).toBeGreaterThanOrEqual(5);
    expect(sp.y).toBeGreaterThanOrEqual(5);
    expect(sp.x + 10).toBeLessThanOrEqual(45);
    expect(sp.y + 10).toBeLessThanOrEqual(45);
  });
});
