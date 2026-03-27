import type { Point, Polygon } from '$lib/geometry/types';
import { boundingBox, signedArea } from '$lib/geometry/polygon';

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
export function computeIFP(
	binWidth: number,
	binHeight: number,
	part: Polygon
): Polygon {
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
		{ x: minX, y: maxY }
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
			y: A[idxA].y + B[idxB].y
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
function computeBisectorOffset(prev: Point, curr: Point, next: Point, distance: number): Point | null {
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
		y: curr.y + (by / bLen) * offset
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
 * Check if all vertices of `inner` are inside `outer`.
 */
export function polygonContainsPolygon(outer: Polygon, inner: Polygon): boolean {
	return inner.every((p) => pointInPolygon(p, outer));
}

/**
 * Check if a point is inside a polygon using ray casting.
 */
export function pointInPolygon(point: Point, polygon: Polygon): boolean {
	let inside = false;
	const n = polygon.length;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const xi = polygon[i].x, yi = polygon[i].y;
		const xj = polygon[j].x, yj = polygon[j].y;
		if (
			yi > point.y !== yj > point.y &&
			point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi
		) {
			inside = !inside;
		}
	}
	return inside;
}

/**
 * Check if two polygons overlap using Separating Axis Theorem (SAT).
 * Works for any convex polygons.
 */
export function polygonsOverlap(a: Polygon, b: Polygon): boolean {
	return !hasSeparatingAxis(a, b) && !hasSeparatingAxis(b, a);
}

function hasSeparatingAxis(a: Polygon, b: Polygon): boolean {
	for (let i = 0; i < a.length; i++) {
		const j = (i + 1) % a.length;
		const edge = { x: a[j].x - a[i].x, y: a[j].y - a[i].y };
		const axis = { x: -edge.y, y: edge.x }; // perpendicular

		let minA = Infinity, maxA = -Infinity;
		for (const p of a) {
			const proj = p.x * axis.x + p.y * axis.y;
			minA = Math.min(minA, proj);
			maxA = Math.max(maxA, proj);
		}

		let minB = Infinity, maxB = -Infinity;
		for (const p of b) {
			const proj = p.x * axis.x + p.y * axis.y;
			minB = Math.min(minB, proj);
			maxB = Math.max(maxB, proj);
		}

		if (maxA <= minB || maxB <= minA) return true;
	}
	return false;
}
