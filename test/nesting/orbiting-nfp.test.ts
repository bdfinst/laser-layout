import { describe, it, expect } from 'vitest';
import { orbitingNFP } from '$lib/nesting/orbiting-nfp';
import { computeNFP, reflexVertices } from '$lib/nesting/nfp';
import { boundingBox, rotatePolygon, signedArea } from '$lib/geometry/polygon';
import type { Point, Polygon } from '$lib/geometry/types';

// --- Test geometry helpers (independent of the implementation under test) ---

function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Andrew's monotone chain — convex hull, returned CCW. */
function convexHull(points: Point[]): Polygon {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function randomConvex(rand: () => number, n: number, scale: number): Polygon {
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    pts.push({ x: (rand() - 0.5) * scale, y: (rand() - 0.5) * scale });
  }
  return convexHull(pts);
}

function translate(poly: Polygon, t: Point): Polygon {
  return poly.map((p) => ({ x: p.x + t.x, y: p.y + t.y }));
}

function pointSegDistSq(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const ex = p.x - (a.x + t * dx);
  const ey = p.y - (a.y + t * dy);
  return ex * ex + ey * ey;
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

function minDistToBoundary(p: Point, poly: Polygon): number {
  let min = Infinity;
  for (let i = 0; i < poly.length; i++) {
    min = Math.min(min, pointSegDistSq(p, poly[i], poly[(i + 1) % poly.length]));
  }
  return Math.sqrt(min);
}

/** A vertex sitting in a polygon's interior by more than `eps` (true penetration). */
function strictlyInside(p: Point, poly: Polygon, eps: number): boolean {
  return pointInPolygon(p, poly) && minDistToBoundary(p, poly) > eps;
}

function properCross(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const o = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = o(b1, b2, a1);
  const d2 = o(b1, b2, a2);
  const d3 = o(a1, a2, b1);
  const d4 = o(a1, a2, b2);
  // Strict proper crossing only: each segment's endpoints must lie on strictly opposite
  // sides of the other line, beyond a small epsilon. A shared endpoint or grazing touch
  // (orientation ≈ 0 within float noise) is a touch, not a crossing, and must not count
  // as overlap.
  const eps = 1e-7;
  const opposite = (a: number, b: number) => (a > eps && b < -eps) || (a < -eps && b > eps);
  return opposite(d1, d2) && opposite(d3, d4);
}

/** Do two simple polygons overlap with positive area (penetration, not mere touching)? */
function properlyOverlap(A: Polygon, B: Polygon, eps = 1e-4): boolean {
  for (const p of A) if (strictlyInside(p, B, eps)) return true;
  for (const p of B) if (strictlyInside(p, A, eps)) return true;
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B.length; j++) {
      if (properCross(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length])) return true;
    }
  }
  return false;
}

function segSegDist(a1: Point, a2: Point, b1: Point, b2: Point): number {
  if (properCross(a1, a2, b1, b2)) return 0;
  return Math.sqrt(
    Math.min(
      pointSegDistSq(a1, b1, b2),
      pointSegDistSq(a2, b1, b2),
      pointSegDistSq(b1, a1, a2),
      pointSegDistSq(b2, a1, a2),
    ),
  );
}

/** Closest approach between the two polygon outlines (0 if they cross). */
function boundaryGap(A: Polygon, B: Polygon): number {
  let min = Infinity;
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B.length; j++) {
      min = Math.min(min, segSegDist(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length]));
    }
  }
  return min;
}

/**
 * Core property: every NFP offset places B *touching* A (outlines graze) and *not*
 * overlapping it. This is what makes the NFP boundary a complete, sound candidate set.
 */
function assertValidNFP(A: Polygon, B: Polygon, nfp: Polygon, label: string) {
  expect(nfp, `${label}: NFP should be constructed`).not.toBeNull();
  expect(nfp.length, `${label}: NFP is a closed loop`).toBeGreaterThanOrEqual(3);
  expect(Math.abs(signedArea(nfp)), `${label}: NFP has positive area`).toBeGreaterThan(1e-6);

  for (let k = 0; k < nfp.length; k++) {
    const placed = translate(B, nfp[k]);
    expect(
      properlyOverlap(A, placed),
      `${label}: NFP vertex ${k} (${nfp[k].x.toFixed(3)},${nfp[k].y.toFixed(3)}) must not overlap A`,
    ).toBe(false);
    expect(boundaryGap(A, placed), `${label}: NFP vertex ${k} must touch A`).toBeLessThan(1e-3);
  }
}

// --- Fixtures ---

const Lshape: Polygon = [
  { x: 0, y: 0 },
  { x: 6, y: 0 },
  { x: 6, y: 2 },
  { x: 2, y: 2 },
  { x: 2, y: 6 },
  { x: 0, y: 6 },
];

const plus: Polygon = [
  { x: 2, y: 0 },
  { x: 4, y: 0 },
  { x: 4, y: 2 },
  { x: 6, y: 2 },
  { x: 6, y: 4 },
  { x: 4, y: 4 },
  { x: 4, y: 6 },
  { x: 2, y: 6 },
  { x: 2, y: 4 },
  { x: 0, y: 4 },
  { x: 0, y: 2 },
  { x: 2, y: 2 },
];

// A chevron / open "V" bracket — a deep concave pocket another can seat into.
const chevron: Polygon = [
  { x: 0, y: 0 },
  { x: 3, y: 0 },
  { x: 6, y: 8 },
  { x: 9, y: 0 },
  { x: 12, y: 0 },
  { x: 8, y: 12 },
  { x: 4, y: 12 },
];

describe('orbitingNFP — convex parity with Minkowski oracle', () => {
  it('matches computeNFP bounds for two unit squares', () => {
    const sq: Polygon = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const nfp = orbitingNFP(sq, sq)!;
    assertValidNFP(sq, sq, nfp, 'unit square');
    const a = boundingBox(nfp);
    const b = boundingBox(computeNFP(sq, sq));
    expect(a.minX).toBeCloseTo(b.minX, 4);
    expect(a.minY).toBeCloseTo(b.minY, 4);
    expect(a.maxX).toBeCloseTo(b.maxX, 4);
    expect(a.maxY).toBeCloseTo(b.maxY, 4);
  });

  it('matches the convex Minkowski NFP bounds across random convex pairs', () => {
    const rand = mulberry32(1234);
    for (let trial = 0; trial < 40; trial++) {
      const A = randomConvex(rand, 6, 40);
      const B = randomConvex(rand, 6, 30);
      if (A.length < 3 || B.length < 3) continue;
      const nfp = orbitingNFP(A, B);
      expect(nfp, `trial ${trial}: NFP built`).not.toBeNull();
      assertValidNFP(A, B, nfp!, `convex trial ${trial}`);

      const o = boundingBox(computeNFP(A, B));
      const g = boundingBox(nfp!);
      expect(g.minX).toBeCloseTo(o.minX, 3);
      expect(g.minY).toBeCloseTo(o.minY, 3);
      expect(g.maxX).toBeCloseTo(o.maxX, 3);
      expect(g.maxY).toBeCloseTo(o.maxY, 3);
    }
  });
});

describe('orbitingNFP — concave correctness', () => {
  it('produces a sound NFP for L / plus / chevron self-pairs', () => {
    for (const [name, poly] of [
      ['L', Lshape],
      ['plus', plus],
      ['chevron', chevron],
    ] as const) {
      const nfp = orbitingNFP(poly, poly);
      assertValidNFP(poly, poly, nfp!, `${name}-${name}`);
    }
  });

  it('mixed concave/convex pairs stay collision-free', () => {
    const tri: Polygon = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 2.5, y: 5 },
    ];
    assertValidNFP(Lshape, tri, orbitingNFP(Lshape, tri)!, 'L-triangle');
    assertValidNFP(plus, tri, orbitingNFP(plus, tri)!, 'plus-triangle');
    assertValidNFP(chevron, tri, orbitingNFP(chevron, tri)!, 'chevron-triangle');
  });

  it('the NFP reaches into A’s concavity (a real pocket seat, not just exterior corners)', () => {
    // The structural payoff of NFP placement (#23/#24): for a concave A the orbiting NFP
    // is itself *non-convex* — its boundary dips into the pocket — and at least one NFP
    // offset seats B touching A's reflex (notch) vertex. Neither is expressible with the
    // old bbox-corner / convex anchor set; this is exactly the candidate it was missing.
    const nfp = orbitingNFP(Lshape, Lshape)!;
    expect(reflexVertices(nfp).length, 'NFP must be non-convex for concave A').toBeGreaterThan(0);

    const notch = reflexVertices(Lshape);
    expect(notch.length).toBeGreaterThan(0);
    const seatsAgainstNotch = nfp.some((offset) => {
      const placed = translate(Lshape, offset);
      return notch.some((r) => minDistToBoundary(r, placed) < 1e-6);
    });
    expect(seatsAgainstNotch, 'some offset must bed B against A’s notch').toBe(true);
  });
});

describe('orbitingNFP — rotation fuzz', () => {
  it('stays collision-free for randomized rotations of B', () => {
    const rand = mulberry32(99);
    const shapes = [Lshape, plus, chevron];
    let checked = 0;
    for (let trial = 0; trial < 60; trial++) {
      const A = shapes[trial % shapes.length];
      const B = shapes[(trial + 1) % shapes.length];
      const angle = rand() * Math.PI * 2;
      const Br = rotatePolygon(B, angle, { x: 0, y: 0 });
      const nfp = orbitingNFP(A, Br);
      if (!nfp) continue; // construction may legitimately bail; engine falls back (P1 guardrail)
      assertValidNFP(A, Br, nfp, `fuzz trial ${trial} angle ${angle.toFixed(2)}`);
      checked++;
    }
    expect(checked, 'most fuzz trials should produce a usable NFP').toBeGreaterThan(50);
  });
});

describe('orbitingNFP — degenerate inputs', () => {
  it('returns null for too-few vertices', () => {
    expect(orbitingNFP([{ x: 0, y: 0 }], Lshape)).toBeNull();
    expect(
      orbitingNFP(
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        Lshape,
      ),
    ).toBeNull();
  });

  it('tolerates a duplicated closing vertex', () => {
    const closed: Polygon = [...Lshape, { ...Lshape[0] }];
    const nfp = orbitingNFP(closed, Lshape);
    assertValidNFP(Lshape, Lshape, nfp!, 'closed-input');
  });
});
