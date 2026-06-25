import { describe, it, expect } from 'vitest';
import { bottomLeftFill } from '$lib/nesting/placement';
import { createNfpCache } from '$lib/nesting/nfp-cache';
import { makeRect } from '../support/parts';
import type { MaterialSheet, PlacedPart } from '$lib/geometry/types';

/**
 * Exact-placement characterization net for `bottomLeftFill` (refactor safety rail).
 *
 * `placement.test.ts` and the lego integration baselines verify placement *properties*
 * (no-overlap, kerf spacing) with tolerances, so a behaviour-perturbing refactor of the
 * placement hot path could pass them undetected. Per CLAUDE.md, `placement.ts` refactors
 * must be byte-for-byte behaviour-preserving given the same RNG. `bottomLeftFill` is
 * deterministic given ordered parts (the GA owns order/rotation upstream), so this net pins
 * the EXACT placed positions/rotations with `toStrictEqual` — on both the fast bbox path
 * (`nfpCache` null) and the exact NFP path (`nfpCache` present). Literals captured from the
 * implementation prior to the decomposition; the goal is bit-for-bit equivalence, not
 * re-litigating placement correctness (the property suite owns that).
 */

const sheet: MaterialSheet = { width: 100, height: 100 };

// Ordered corpus: five rectangles that exercise bottom-left gap-filling, plus one part too
// large to fit (so the placed array is non-trivially non-empty and the unplaced assertion is
// not vacuously true).
function corpus() {
  return [
    { part: makeRect('r1', 40, 30), rotation: 0 },
    { part: makeRect('r2', 30, 40), rotation: 0 },
    { part: makeRect('r3', 25, 25), rotation: 0 },
    { part: makeRect('r4', 50, 20), rotation: 0 },
    { part: makeRect('r5', 20, 50), rotation: 0 },
    { part: makeRect('huge', 200, 200), rotation: 0 }, // cannot fit the 100x100 sheet
  ];
}

// `mirror` is normalized undefined→false so a refactor that flips mirror state is caught.
const slim = (p: PlacedPart) => ({
  id: p.part.id,
  x: p.x,
  y: p.y,
  rotation: p.rotation,
  mirror: p.mirror ?? false,
});

// The exact placement both paths produce for this corpus (captured from the pre-refactor impl).
const EXPECTED = [
  { id: 'r1', x: 0, y: 0, rotation: 0, mirror: false },
  { id: 'r2', x: 40, y: 0, rotation: 0, mirror: false },
  { id: 'r3', x: 70, y: 0, rotation: 0, mirror: false },
  { id: 'r4', x: 0, y: 40, rotation: 0, mirror: false },
  { id: 'r5', x: 70, y: 25, rotation: 0, mirror: false },
];

describe('bottomLeftFill — exact-placement characterization', () => {
  it('pins exact placements on the fast bbox path (nfpCache null)', () => {
    const placed = bottomLeftFill(corpus(), sheet, 0, true, null);
    expect(placed.map(slim)).toStrictEqual(EXPECTED);
  });

  it('pins exact placements on the exact NFP path (nfpCache present)', () => {
    const placed = bottomLeftFill(corpus(), sheet, 0, true, createNfpCache());
    expect(placed.map(slim)).toStrictEqual(EXPECTED);
  });

  it('reports the oversized part unplaced rather than forcing an overlap (both paths)', () => {
    // Six parts in, five placed: 'huge' is dropped, not stuffed in overlapping another.
    for (const cache of [null, createNfpCache()]) {
      const placed = bottomLeftFill(corpus(), sheet, 0, true, cache);
      expect(placed).toHaveLength(5);
      expect(placed.map((p) => p.part.id)).not.toContain('huge');
    }
  });

  it('is discriminating — a single-coordinate drift would fail the net', () => {
    // Committed proof the net is not loose: the same expected set with one coordinate moved by
    // 1mm must NOT match the real output, so any real placement drift trips toStrictEqual above.
    // (Authoring-time sensitivity was also verified by perturbing a captured literal and watching
    // the pin fail before restoring it.)
    const placed = bottomLeftFill(corpus(), sheet, 0, true, null);
    const drifted = EXPECTED.map((e, i) => (i === 0 ? { ...e, x: e.x + 1 } : e));
    expect(placed.map(slim)).not.toStrictEqual(drifted);
  });
});
