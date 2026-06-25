import { describe, it, expect } from 'vitest';
import { orbitingNFP } from '$lib/nesting/orbiting-nfp';
import type { Polygon } from '$lib/geometry/types';

/**
 * Exact-output characterization net for `orbitingNFP` (refactor safety rail).
 *
 * The orbiting-nfp property/fuzz suite checks *invariants* (touch + no-overlap) with
 * tolerances, and the lego integration baselines use deliberately wide tolerances — so a
 * behaviour-perturbing refactor of the numerically-sensitive orbit loop could pass them
 * undetected. This file pins the **exact** offset sequences the current implementation
 * returns (asserted with `toStrictEqual`, not `toBeCloseTo`), so any coordinate change of
 * any magnitude fails the build. Expected literals were captured from the implementation
 * prior to the decomposition; the goal is bit-for-bit *equivalence*, not re-litigating
 * correctness (the invariant suite already owns correctness).
 */

// A concave polygon with reflex vertices — the orbit dips into the pocket (non-convex NFP).
const Lshape: Polygon = [
  { x: 0, y: 0 },
  { x: 6, y: 0 },
  { x: 6, y: 2 },
  { x: 2, y: 2 },
  { x: 2, y: 6 },
  { x: 0, y: 6 },
];

// Two axis-aligned bars: the orbit traverses coincident (shared) horizontal edges, which
// exercises the on-segment contact and anti-parallel slide-rejection branches.
const barA: Polygon = [
  { x: 0, y: 0 },
  { x: 8, y: 0 },
  { x: 8, y: 3 },
  { x: 0, y: 3 },
];
const barB: Polygon = [
  { x: 0, y: 0 },
  { x: 5, y: 0 },
  { x: 5, y: 2 },
  { x: 0, y: 2 },
];

// A degenerate collinear "triangle": 3 distinct points on one line. It passes the
// `length < 3` pre-loop guard, so orbitingNFP *enters the orbit loop* and still returns
// null (via the in-loop stall or the post-loop `trace.length < 3` guard — both pinned as
// null here). This covers a null that is reached through the loop, distinct from the
// trivial vertex-count rejection the existing degenerate suite already pins.
const collinear: Polygon = [
  { x: 0, y: 0 },
  { x: 2, y: 0 },
  { x: 5, y: 0 },
];

describe('orbitingNFP — exact-output characterization', () => {
  it('pins the exact NFP offsets for the L-shape self-pair', () => {
    expect(orbitingNFP(Lshape, Lshape)).toStrictEqual([
      { x: -2, y: -6 },
      { x: 4, y: -6 },
      { x: 6, y: -6 },
      { x: 6, y: 0 },
      { x: 6, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: 6 },
      { x: -4, y: 6 },
      { x: -6, y: 6 },
      { x: -6, y: 0 },
      { x: -6, y: -2 },
      { x: -2, y: -2 },
    ]);
  });

  it('pins the exact NFP offsets for a pair with shared horizontal edges', () => {
    expect(orbitingNFP(barA, barB)).toStrictEqual([
      { x: -5, y: -2 },
      { x: 3, y: -2 },
      { x: 8, y: -2 },
      { x: 8, y: 1 },
      { x: 8, y: 3 },
      { x: 0, y: 3 },
      { x: -5, y: 3 },
      { x: -5, y: 0 },
    ]);
  });

  it('returns null when the orbit enters the loop but cannot close', () => {
    // B is collinear (length 3 → passes the pre-loop guard), so this is the in-loop
    // null path, distinct from the vertex-count rejection covered elsewhere.
    expect(orbitingNFP(Lshape, collinear)).toBeNull();
  });

  it('is deterministic — successive calls return deep-equal results', () => {
    // Guards against a refactor introducing call-to-call state: e.g. a module-level
    // accumulator or shared cache mutated across invocations. Pure today, so this is a
    // tripwire for that regression class, not a property of the current code.
    const first = orbitingNFP(Lshape, Lshape);
    const second = orbitingNFP(Lshape, Lshape);
    expect(second).toStrictEqual(first);
  });
});
