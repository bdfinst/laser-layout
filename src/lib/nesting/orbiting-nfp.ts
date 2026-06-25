import type { Point, Polygon } from '$lib/geometry/types';
import { ensureCCW } from './nfp';

/**
 * Robust orbiting/sliding No-Fit-Polygon generator (epic #24, phase P1).
 *
 * `computeNFP` in `nfp.ts` is convex-only (Minkowski sum). This module computes the
 * NFP of two *simple, possibly concave* polygons by orbiting B around A's boundary
 * while tracking every touching vertex/edge contact (Burke et al. 2007). The traced
 * loop is the exact locus of touching-but-not-overlapping placements, so — unlike a
 * hand-picked anchor set — it *already contains the deep concave seats* where B beds
 * into A's pocket touching at two contacts at once. Output has O(nA + nB) vertices.
 *
 * This is the correctness core the epic is gated on. It is intentionally standalone:
 * nothing in the nesting engine calls it yet (P3+). It is validated against the convex
 * Minkowski path as an oracle and by randomized fuzz (`orbiting-nfp.test.ts`).
 *
 * Algorithm credit: the sliding/orbiting formulation popularised by SVGnest
 * (J. Qiao, MIT) — re-implemented here in this codebase's geometry types.
 */

const TOL = 1e-9;

function almostEqual(a: number, b: number, tol = TOL): boolean {
  return Math.abs(a - b) < tol;
}

function normalize(v: Point): Point {
  const len2 = v.x * v.x + v.y * v.y;
  if (almostEqual(len2, 1)) return v;
  const len = Math.sqrt(len2);
  return { x: v.x / len, y: v.y / len };
}

/**
 * Is point `p` strictly on the open segment A→B (collinear, between endpoints,
 * excluding the endpoints themselves)? Tolerance-aware for the vertical/horizontal
 * degenerate cases that wreck a naive cross-product test.
 */
function onSegment(a: Point, b: Point, p: Point): boolean {
  // Vertical segment
  if (almostEqual(a.x, b.x) && almostEqual(p.x, a.x)) {
    return (
      !almostEqual(p.y, a.y) &&
      !almostEqual(p.y, b.y) &&
      p.y < Math.max(a.y, b.y) &&
      p.y > Math.min(a.y, b.y)
    );
  }
  // Horizontal segment
  if (almostEqual(a.y, b.y) && almostEqual(p.y, a.y)) {
    return (
      !almostEqual(p.x, a.x) &&
      !almostEqual(p.x, b.x) &&
      p.x < Math.max(a.x, b.x) &&
      p.x > Math.min(a.x, b.x)
    );
  }
  // Outside the bounding range
  if (
    (p.x < a.x && p.x < b.x) ||
    (p.x > a.x && p.x > b.x) ||
    (p.y < a.y && p.y < b.y) ||
    (p.y > a.y && p.y > b.y)
  ) {
    return false;
  }
  // Endpoints excluded
  if (
    (almostEqual(p.x, a.x) && almostEqual(p.y, a.y)) ||
    (almostEqual(p.x, b.x) && almostEqual(p.y, b.y))
  ) {
    return false;
  }
  const cross = (p.y - a.y) * (b.x - a.x) - (p.x - a.x) * (b.y - a.y);
  if (Math.abs(cross) > TOL) return false;
  const dot = (p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y);
  if (dot < 0 || almostEqual(dot, 0)) return false;
  const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  if (dot > len2 || almostEqual(dot, len2)) return false;
  return true;
}

/**
 * Signed distance from `p` to the line through s1→s2 measured along `normal`.
 * When `infinite` is false, returns null if `p` projects outside the segment span.
 */
function pointDistance(
  p: Point,
  s1: Point,
  s2: Point,
  normal: Point,
  infinite = false,
): number | null {
  const n = normalize(normal);
  const dir = { x: n.y, y: -n.x };

  const pdot = p.x * dir.x + p.y * dir.y;
  const s1dot = s1.x * dir.x + s1.y * dir.y;
  const s2dot = s2.x * dir.x + s2.y * dir.y;

  const pdotnorm = p.x * n.x + p.y * n.y;
  const s1dotnorm = s1.x * n.x + s1.y * n.y;
  const s2dotnorm = s2.x * n.x + s2.y * n.y;

  if (!infinite) {
    if ((pdot < s1dot || almostEqual(pdot, s1dot)) && (pdot < s2dot || almostEqual(pdot, s2dot))) {
      return null;
    }
    if ((pdot > s1dot || almostEqual(pdot, s1dot)) && (pdot > s2dot || almostEqual(pdot, s2dot))) {
      return null;
    }
  }

  return -(pdotnorm - s1dotnorm + ((s1dotnorm - s2dotnorm) * (s1dot - pdot)) / (s1dot - s2dot));
}

/**
 * Slide distance for one endpoint (`point`) projecting into the interior of the opposing
 * span `s1→s2`, measured along `dir`. A near-zero distance is only a real collision when the
 * partner endpoint `other` is genuinely ahead (positive, non-grazing) along the same ray;
 * otherwise the touch is a grazing artifact and contributes nothing. Returns null when there
 * is no blocking collision. Shared by the four endpoint cases of `segmentDistance`.
 */
function interiorSlideDistance(
  point: Point,
  s1: Point,
  s2: Point,
  other: Point,
  dir: Point,
  overlap: number,
): number | null {
  let d = pointDistance(point, s1, s2, dir);
  if (d !== null && almostEqual(d, 0)) {
    const dOther = pointDistance(other, s1, s2, dir, true);
    if (dOther === null || dOther < 0 || almostEqual(dOther * overlap, 0)) d = null;
  }
  return d;
}

/**
 * How far the moving edge E→F can travel along `direction` before colliding with the
 * static edge A→B. Returns null when no collision occurs along that ray. This is the
 * delicate kernel of the orbit; the four blocks mirror the four ways the two segments
 * can first meet (each endpoint of one against the span of the other).
 */
function segmentDistance(a: Point, b: Point, e: Point, f: Point, direction: Point): number | null {
  const normal = { x: direction.y, y: -direction.x };
  const reverse = { x: -direction.x, y: -direction.y };

  const dotA = a.x * normal.x + a.y * normal.y;
  const dotB = b.x * normal.x + b.y * normal.y;
  const dotE = e.x * normal.x + e.y * normal.y;
  const dotF = f.x * normal.x + f.y * normal.y;

  const crossA = a.x * direction.x + a.y * direction.y;
  const crossB = b.x * direction.x + b.y * direction.y;
  const crossE = e.x * direction.x + e.y * direction.y;
  const crossF = f.x * direction.x + f.y * direction.y;

  const abMin = Math.min(dotA, dotB);
  const abMax = Math.max(dotA, dotB);
  const efMax = Math.max(dotE, dotF);
  const efMin = Math.min(dotE, dotF);

  // The spans only graze at a single point, or miss entirely — no sliding collision.
  if (almostEqual(abMax, efMin) || almostEqual(abMin, efMax)) return null;
  if (abMax < efMin || abMin > efMax) return null;

  let overlap: number;
  if ((abMax > efMax && abMin < efMin) || (efMax > abMax && efMin < abMin)) {
    overlap = 1;
  } else {
    const minMax = Math.min(abMax, efMax);
    const maxMin = Math.max(abMin, efMin);
    const maxMax = Math.max(abMax, efMax);
    const minMin = Math.min(abMin, efMin);
    overlap = (minMax - maxMin) / (maxMax - minMin);
  }

  const crossABE = (e.y - a.y) * (b.x - a.x) - (e.x - a.x) * (b.y - a.y);
  const crossABF = (f.y - a.y) * (b.x - a.x) - (f.x - a.x) * (b.y - a.y);

  // Collinear edges: they can only block the slide if their normals oppose and the
  // motion is into the static edge.
  if (almostEqual(crossABE, 0) && almostEqual(crossABF, 0)) {
    const abNorm = normalize({ x: b.y - a.y, y: a.x - b.x });
    const efNorm = normalize({ x: f.y - e.y, y: e.x - f.x });
    if (
      Math.abs(abNorm.y * efNorm.x - abNorm.x * efNorm.y) < TOL &&
      abNorm.y * efNorm.y + abNorm.x * efNorm.x < 0
    ) {
      const normdot = abNorm.y * direction.y + abNorm.x * direction.x;
      if (almostEqual(normdot, 0)) return null;
      if (normdot < 0) return 0;
    }
    return null;
  }

  const distances: number[] = [];

  // Static endpoints A, B against the moving span E→F (measured along `reverse`).
  if (almostEqual(dotA, dotE)) {
    distances.push(crossA - crossE);
  } else if (almostEqual(dotA, dotF)) {
    distances.push(crossA - crossF);
  } else if (dotA > efMin && dotA < efMax) {
    const d = interiorSlideDistance(a, e, f, b, reverse, overlap);
    if (d !== null) distances.push(d);
  }

  if (almostEqual(dotB, dotE)) {
    distances.push(crossB - crossE);
  } else if (almostEqual(dotB, dotF)) {
    distances.push(crossB - crossF);
  } else if (dotB > efMin && dotB < efMax) {
    const d = interiorSlideDistance(b, e, f, a, reverse, overlap);
    if (d !== null) distances.push(d);
  }

  // Moving endpoints E, F against the static span A→B (measured along `direction`).
  if (dotE > abMin && dotE < abMax) {
    const d = interiorSlideDistance(e, a, b, f, direction, overlap);
    if (d !== null) distances.push(d);
  }

  if (dotF > abMin && dotF < abMax) {
    const d = interiorSlideDistance(f, a, b, e, direction, overlap);
    if (d !== null) distances.push(d);
  }

  if (distances.length === 0) return null;
  return Math.min(...distances);
}

/**
 * Largest distance polygon B (already in world coords) can slide along `direction`
 * before any of its edges hits any edge of static polygon A. `ignoreNegative` drops
 * collisions that lie behind the current position (the part is already moving away).
 */
function polygonSlideDistance(
  a: Polygon,
  b: Polygon,
  direction: Point,
  ignoreNegative: boolean,
): number | null {
  const dir = normalize(direction);
  const na = a.length;
  const nb = b.length;
  let distance: number | null = null;

  for (let i = 0; i < nb; i++) {
    const b1 = b[i];
    const b2 = b[(i + 1) % nb];
    if (b1.x === b2.x && b1.y === b2.y) continue;
    for (let j = 0; j < na; j++) {
      const a1 = a[j];
      const a2 = a[(j + 1) % na];
      if (a1.x === a2.x && a1.y === a2.y) continue;

      const d = segmentDistance(a1, a2, b1, b2, dir);
      if (d !== null && (distance === null || d < distance)) {
        if (!ignoreNegative || d > 0 || almostEqual(d, 0)) {
          distance = d;
        }
      }
    }
  }
  return distance;
}

type SlideVector = Point;

type Contact = { type: 0 | 1 | 2; a: number; b: number };

/**
 * The moving body's state as B is orbited around A. `refx/refy` track the locus of B's
 * reference vertex (B[0]); `offx/offy` accumulate the offset from B's original frame; `Bo`
 * is B in world coordinates at the current offset. All advance together each iteration.
 */
interface OrbitCursor {
  refx: number;
  refy: number;
  offx: number;
  offy: number;
  Bo: Polygon;
}

/** Strip a duplicated closing vertex and orient CCW so the orbit winds consistently. */
function prepare(poly: Polygon): Polygon {
  let p = poly;
  const last = p.length - 1;
  if (last > 0 && almostEqual(p[0].x, p[last].x) && almostEqual(p[0].y, p[last].y)) {
    p = p.slice(0, last);
  }
  return ensureCCW(p);
}

/**
 * Phase 1: every current touching contact between A and the orbiting body `Bo` — a
 * coincident vertex pair (type 0), an A-edge touching a B-vertex (type 1), or a B-edge
 * touching an A-vertex (type 2). `Bo` has the same length as the original B.
 */
function collectContacts(A: Polygon, Bo: Polygon): Contact[] {
  const touching: Contact[] = [];
  for (let i = 0; i < A.length; i++) {
    const nexti = (i + 1) % A.length;
    for (let j = 0; j < Bo.length; j++) {
      const nextj = (j + 1) % Bo.length;
      if (almostEqual(A[i].x, Bo[j].x) && almostEqual(A[i].y, Bo[j].y)) {
        touching.push({ type: 0, a: i, b: j });
      } else if (onSegment(A[i], A[nexti], Bo[j])) {
        touching.push({ type: 1, a: nexti, b: j });
      } else if (onSegment(Bo[j], Bo[nextj], A[i])) {
        touching.push({ type: 2, a: i, b: nextj });
      }
    }
  }
  return touching;
}

/**
 * Phase 2: the candidate slide directions a single contact contributes. A coincident
 * vertex (type 0) yields A's two incident edges and B's two incident edges inverted; an
 * edge/vertex contact (types 1, 2) yields the touching edge and one neighbour.
 */
function slideVectorsFor(t: Contact, A: Polygon, Bo: Polygon): SlideVector[] {
  const vectors: SlideVector[] = [];
  const prevA = A[(t.a - 1 + A.length) % A.length];
  const vA = A[t.a];
  const nextA = A[(t.a + 1) % A.length];
  const prevB = Bo[(t.b - 1 + Bo.length) % Bo.length];
  const vB = Bo[t.b];
  const nextB = Bo[(t.b + 1) % Bo.length];

  if (t.type === 0) {
    vectors.push({ x: prevA.x - vA.x, y: prevA.y - vA.y });
    vectors.push({ x: nextA.x - vA.x, y: nextA.y - vA.y });
    // B's edges, inverted (B is the moving body).
    vectors.push({ x: vB.x - prevB.x, y: vB.y - prevB.y });
    vectors.push({ x: vB.x - nextB.x, y: vB.y - nextB.y });
  } else if (t.type === 1) {
    vectors.push({ x: vA.x - vB.x, y: vA.y - vB.y });
    vectors.push({ x: prevA.x - vB.x, y: prevA.y - vB.y });
  } else {
    vectors.push({ x: vA.x - vB.x, y: vA.y - vB.y });
    vectors.push({ x: vA.x - prevB.x, y: vA.y - prevB.y });
  }
  return vectors;
}

/**
 * Phase 3: pick the longest feasible slide among the candidate vectors, skipping zero
 * vectors and any that anti-parallel back along `prev` (where the orbit just came from).
 * Each survivor's reach is clamped by `polygonSlideDistance`.
 */
function pickLongestSlide(
  vectors: SlideVector[],
  A: Polygon,
  Bo: Polygon,
  prev: SlideVector | null,
): { translate: SlideVector | null; maxd: number } {
  let translate: SlideVector | null = null;
  let maxd = 0;
  for (const v of vectors) {
    if (v.x === 0 && v.y === 0) continue;
    if (prev && v.y * prev.y + v.x * prev.x < 0) {
      const u = normalize(v);
      const pu = normalize(prev);
      if (Math.abs(u.y * pu.x - u.x * pu.y) < 1e-4) continue; // anti-parallel: came from here
    }

    let d = polygonSlideDistance(A, Bo, v, true);
    const vlen2 = v.x * v.x + v.y * v.y;
    if (d === null || d * d > vlen2) d = Math.sqrt(vlen2);

    if (d > maxd) {
      maxd = d;
      translate = v;
    }
  }
  return { translate, maxd };
}

/** Phase 5a: has the reference vertex returned exactly to the orbit's start (loop closed)? */
function hasClosedOrbit(refx: number, refy: number, startx: number, starty: number): boolean {
  return almostEqual(refx, startx) && almostEqual(refy, starty);
}

/**
 * Phase 5b: has the reference vertex revisited an earlier (non-final) trace point? This can
 * happen with shared horizontal edges and means the orbit is looping without closing.
 * Checked only after {@link hasClosedOrbit} so the start-revisit case wins, as before.
 */
function hasRevisitedTrace(refx: number, refy: number, trace: Point[]): boolean {
  for (let i = 0; i < trace.length - 1; i++) {
    if (almostEqual(refx, trace[i].x) && almostEqual(refy, trace[i].y)) return true;
  }
  return false;
}

/**
 * Trace the exterior No-Fit Polygon of two simple polygons by orbiting B around A.
 *
 * Returns the NFP as a list of **translation offsets** for B: placing B at offset `t`
 * (every vertex of B shifted by `t`) seats it touching A without overlap. This matches
 * the convention of the convex `computeNFP` (its vertices are likewise valid B offsets),
 * so the two are directly comparable. Returns `null` if the orbit fails to close (the
 * caller should fall back to its existing anchor set, per the epic's guardrail).
 */
export function orbitingNFP(staticPoly: Polygon, orbitingPoly: Polygon): Polygon | null {
  const A = prepare(staticPoly);
  const B = prepare(orbitingPoly);
  if (A.length < 3 || B.length < 3) return null;

  // Start guaranteed outside-and-touching: align A's lowest vertex with B's highest,
  // so B hangs entirely below A, the two meeting at exactly that one point.
  let minAi = 0;
  for (let i = 1; i < A.length; i++) if (A[i].y < A[minAi].y) minAi = i;
  let maxBi = 0;
  for (let i = 1; i < B.length; i++) if (B[i].y > B[maxBi].y) maxBi = i;

  const offx = A[minAi].x - B[maxBi].x;
  const offy = A[minAi].y - B[maxBi].y;
  // B in world coordinates at the current offset, and the reference-vertex locus (B[0]).
  const Bo0: Polygon = B.map((p) => ({ x: p.x + offx, y: p.y + offy }));
  const cur: OrbitCursor = { refx: Bo0[0].x, refy: Bo0[0].y, offx, offy, Bo: Bo0 };

  // NFP is the locus of B's reference vertex (B[0]); convert to offsets at the end.
  const startx = cur.refx;
  const starty = cur.refy;
  const trace: Point[] = [{ x: cur.refx, y: cur.refy }];

  let prev: SlideVector | null = null;
  const maxIter = 10 * (A.length + B.length);

  for (let counter = 0; counter < maxIter; counter++) {
    // 1. Collect every current contact between A and B.
    const touching = collectContacts(A, cur.Bo);

    // 2. Each contact contributes candidate slide directions.
    const vectors: SlideVector[] = [];
    for (const t of touching) vectors.push(...slideVectorsFor(t, A, cur.Bo));

    // 3. Pick the longest feasible slide, rejecting any that doubles back.
    const { translate, maxd } = pickLongestSlide(vectors, A, cur.Bo, prev);

    if (translate === null || almostEqual(maxd, 0)) {
      return null; // orbit stalled — construction failed for this pair
    }

    prev = translate;

    // Trim the chosen vector to the actual feasible distance.
    const vlen2 = translate.x * translate.x + translate.y * translate.y;
    let tx = translate.x;
    let ty = translate.y;
    if (maxd * maxd < vlen2 && !almostEqual(maxd * maxd, vlen2)) {
      const scale = Math.sqrt((maxd * maxd) / vlen2);
      tx *= scale;
      ty *= scale;
    }

    cur.refx += tx;
    cur.refy += ty;

    if (hasClosedOrbit(cur.refx, cur.refy, startx, starty)) break; // closed the loop
    // Guard against a non-start re-visit (can happen with shared horizontal edges).
    if (hasRevisitedTrace(cur.refx, cur.refy, trace)) break;

    trace.push({ x: cur.refx, y: cur.refy });
    cur.offx += tx;
    cur.offy += ty;
    cur.Bo = cur.Bo.map((p) => ({ x: p.x + tx, y: p.y + ty }));
  }

  if (trace.length < 3) return null;

  // Convert the B[0]-locus into offsets usable as `B + offset`.
  const b0 = B[0];
  return trace.map((p) => ({ x: p.x - b0.x, y: p.y - b0.y }));
}
