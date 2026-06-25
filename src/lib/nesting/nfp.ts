import type { Point, Polygon } from '$lib/geometry/types';
import {
  boundingBox,
  signedArea,
  pointInPolygon,
  polygonContainsPolygon,
} from '$lib/geometry/polygon';

// Re-exported from the geometry layer so existing `$lib/nesting/nfp` importers keep working.
// These are pure containment primitives and live in geometry/polygon.ts to avoid a
// geometry -> nesting dependency (e.g. geometry/grouping.ts consuming them).
export { pointInPolygon, polygonContainsPolygon };

/**
 * Compute the No-Fit Polygon (NFP) of two convex polygons.
 * The NFP defines the set of positions where polygon B's reference point
 * cannot be placed without overlapping polygon A.
 *
 * Uses the Minkowski sum approach: NFP = A ⊕ (-B)
 * For convex polygons, this is computed by merging sorted edge vectors.
 */
export function computeNFP(staticPoly: Polygon, orbitingPoly: Polygon): Polygon {
  const A = ensureCCW(staticPoly);
  const B = ensureCCW(orbitingPoly);

  // Negate B (reflect through origin)
  const negB: Polygon = B.map((p) => ({ x: -p.x, y: -p.y }));

  return minkowskiConvex(A, negB);
}

/**
 * Compute the Inner-Fit Polygon (IFP) — the region where a part's
 * reference point can be placed inside a rectangular bin.
 */
export function computeIFP(binWidth: number, binHeight: number, part: Polygon): Polygon {
  const bb = boundingBox(part);
  // The reference point can move within the bin minus the part's extent
  const minX = -bb.minX;
  const minY = -bb.minY;
  const maxX = binWidth - bb.maxX;
  const maxY = binHeight - bb.maxY;

  if (maxX < minX || maxY < minY) return []; // part doesn't fit

  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
}

/**
 * Minkowski sum of two convex polygons using the rotating calipers method.
 */
function minkowskiConvex(A: Polygon, B: Polygon): Polygon {
  // Find bottom-most points as starting vertices
  let startA = 0;
  let startB = 0;
  for (let i = 1; i < A.length; i++) {
    if (A[i].y < A[startA].y || (A[i].y === A[startA].y && A[i].x < A[startA].x)) {
      startA = i;
    }
  }
  for (let i = 1; i < B.length; i++) {
    if (B[i].y < B[startB].y || (B[i].y === B[startB].y && B[i].x < B[startB].x)) {
      startB = i;
    }
  }

  const nA = A.length;
  const nB = B.length;
  const result: Point[] = [];

  let iA = 0;
  let iB = 0;

  while (iA < nA || iB < nB) {
    const idxA = (startA + iA) % nA;
    const idxB = (startB + iB) % nB;

    result.push({
      x: A[idxA].x + B[idxB].x,
      y: A[idxA].y + B[idxB].y,
    });

    if (iA >= nA) {
      iB++;
      continue;
    }
    if (iB >= nB) {
      iA++;
      continue;
    }

    const nextA = (startA + iA + 1) % nA;
    const nextB = (startB + iB + 1) % nB;

    const edgeA = { x: A[nextA].x - A[idxA].x, y: A[nextA].y - A[idxA].y };
    const edgeB = { x: B[nextB].x - B[idxB].x, y: B[nextB].y - B[idxB].y };

    const cross = edgeA.x * edgeB.y - edgeA.y * edgeB.x;

    if (cross > 0) {
      iA++;
    } else if (cross < 0) {
      iB++;
    } else {
      iA++;
      iB++;
    }
  }

  return result;
}

export function ensureCCW(polygon: Polygon): Polygon {
  return signedArea(polygon) < 0 ? [...polygon].reverse() : polygon;
}

/** Compute the inset point for a single vertex along its angle bisector. Returns null if degenerate. */
function computeBisectorOffset(
  prev: Point,
  curr: Point,
  next: Point,
  distance: number,
): Point | null {
  const e1x = curr.x - prev.x;
  const e1y = curr.y - prev.y;
  const e2x = next.x - curr.x;
  const e2y = next.y - curr.y;

  // Inward normals (for CCW polygon, inward is left-hand: (-dy, dx) normalized)
  const len1 = Math.sqrt(e1x * e1x + e1y * e1y);
  const len2 = Math.sqrt(e2x * e2x + e2y * e2y);
  if (len1 === 0 || len2 === 0) return null;

  const n1x = -e1y / len1;
  const n1y = e1x / len1;
  const n2x = -e2y / len2;
  const n2y = e2x / len2;

  const bx = n1x + n2x;
  const by = n1y + n2y;
  const bLen = Math.sqrt(bx * bx + by * by);
  if (bLen < 1e-10) return null;

  // cos(halfAngle) = dot(bisector_normalized, n1)
  const cosHalf = (bx * n1x + by * n1y) / bLen;
  if (Math.abs(cosHalf) < 1e-10) return null;

  const offset = distance / cosHalf;
  return {
    x: curr.x + (bx / bLen) * offset,
    y: curr.y + (by / bLen) * offset,
  };
}

/**
 * Shrink a polygon inward by `distance` along each vertex's angle bisector.
 * Assumes convex polygon. Returns empty array if the polygon collapses.
 */
export function insetPolygon(polygon: Polygon, distance: number): Polygon {
  if (distance === 0) return polygon;
  const ccw = ensureCCW(polygon);
  const n = ccw.length;
  if (n < 3) return [];

  const result: Point[] = [];
  for (let i = 0; i < n; i++) {
    const pt = computeBisectorOffset(ccw[(i - 1 + n) % n], ccw[i], ccw[(i + 1) % n], distance);
    if (pt) result.push(pt);
  }

  if (result.length < 3) return [];

  // The inset polygon must have strictly smaller absolute area than the original
  const area = Math.abs(signedArea(result));
  const originalArea = Math.abs(signedArea(ccw));
  if (area < 1e-6 || area >= originalArea - 1e-6) return [];

  return result;
}

/**
 * Check if two polygons overlap using Separating Axis Theorem (SAT).
 * Works for any convex polygons. For CONCAVE polygons use `polygonsInterpenetrate`
 * instead — SAT can report false negatives (two concave shapes may overlap yet still
 * have a separating edge-normal), which lets overlapping placements slip through.
 */
export function polygonsOverlap(a: Polygon, b: Polygon): boolean {
  return !hasSeparatingAxis(a, b) && !hasSeparatingAxis(b, a);
}

/**
 * True-shape interpenetration test for simple, possibly concave polygons. Returns true
 * only when the outlines properly cross or one polygon contains a vertex of the other —
 * i.e. genuine overlap. Touching along a shared edge or vertex is NOT interpenetration
 * (segment crossings use strict orientation signs), so abutting common-line placements at
 * kerf 0 are allowed. Use this instead of the convex-only `polygonsOverlap` whenever the
 * inputs may be concave (every real part outline can be).
 */
export function polygonsInterpenetrate(a: Polygon, b: Polygon): boolean {
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i];
    const a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      if (segmentsIntersect(a1, a2, b[j], b[(j + 1) % b.length])) return true;
    }
  }
  // No proper crossings ⇒ the polygons are disjoint or one is wholly inside the other.
  // Any vertex of one inside the other settles it; checking all is cheap and robust to the
  // case where the reference vertex happens to sit on a shared boundary.
  if (a.some((p) => pointInPolygon(p, b))) return true;
  if (b.some((p) => pointInPolygon(p, a))) return true;
  return false;
}

function hasSeparatingAxis(a: Polygon, b: Polygon): boolean {
  for (let i = 0; i < a.length; i++) {
    const j = (i + 1) % a.length;
    const edge = { x: a[j].x - a[i].x, y: a[j].y - a[i].y };
    const axis = { x: -edge.y, y: edge.x }; // perpendicular

    let minA = Infinity,
      maxA = -Infinity;
    for (const p of a) {
      const proj = p.x * axis.x + p.y * axis.y;
      minA = Math.min(minA, proj);
      maxA = Math.max(maxA, proj);
    }

    let minB = Infinity,
      maxB = -Infinity;
    for (const p of b) {
      const proj = p.x * axis.x + p.y * axis.y;
      minB = Math.min(minB, proj);
      maxB = Math.max(maxB, proj);
    }

    if (maxA <= minB || maxB <= minA) return true;
  }
  return false;
}

// --- Concavity anchors (NFP-flavored candidate generation, #12) ---

/**
 * Reflex (concave) vertices of a polygon — the inner corners of its notches. These are
 * the positions where another part can tuck into a concavity. An NFP-flavored approximation
 * of full non-convex no-fit-polygon placement: seed candidate anchors here, then validate
 * with exact collision. Winding-independent. Returns [] for convex polygons / triangles.
 */
export function reflexVertices(poly: Polygon): Point[] {
  const n = poly.length;
  if (n < 4) return [];
  const ccw = signedArea(poly) > 0;
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n];
    const curr = poly[i];
    const next = poly[(i + 1) % n];
    const cross = (curr.x - prev.x) * (next.y - curr.y) - (curr.y - prev.y) * (next.x - curr.x);
    if (ccw ? cross < 0 : cross > 0) out.push(curr);
  }
  return out;
}

// --- Polygon proximity (true-shape spacing for kerf > 0, #11) ---

function pointSegmentDistanceSq(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const ex = p.x - (a.x + t * dx);
  const ey = p.y - (a.y + t * dy);
  return ex * ex + ey * ey;
}

function orient(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

function segmentDistanceSq(a1: Point, a2: Point, b1: Point, b2: Point): number {
  if (segmentsIntersect(a1, a2, b1, b2)) return 0;
  return Math.min(
    pointSegmentDistanceSq(a1, b1, b2),
    pointSegmentDistanceSq(a2, b1, b2),
    pointSegmentDistanceSq(b1, a1, a2),
    pointSegmentDistanceSq(b2, a1, a2),
  );
}

/**
 * True-shape proximity test: are polygons `a` and `b` closer than `dist` (overlapping,
 * one containing the other, or their outlines within `dist`)? Exact for concave polygons.
 * Touching at exactly `dist` is NOT closer (strict less-than). Used to honor kerf spacing
 * by true outline rather than bounding box. Compares squared distances to avoid sqrt.
 */
export function polygonsCloserThan(a: Polygon, b: Polygon, dist: number): boolean {
  // Containment (no edge crossing): a vertex of one inside the other.
  if (pointInPolygon(a[0], b) || pointInPolygon(b[0], a)) return true;
  const distSq = dist * dist;
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i];
    const a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const b1 = b[j];
      const b2 = b[(j + 1) % b.length];
      if (segmentDistanceSq(a1, a2, b1, b2) < distSq) return true;
    }
  }
  return false;
}
