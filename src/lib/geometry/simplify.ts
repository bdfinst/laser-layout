import type { Point, Polygon } from './types';

/**
 * Douglas-Peucker polygon simplification.
 * Reduces point count while preserving shape within the given tolerance.
 */
export function simplifyPolygon(polygon: Polygon, tolerance: number): Polygon {
	if (polygon.length <= 3) return polygon;

	const result = douglasPeucker(polygon, tolerance);

	// Ensure we still have at least 3 points
	if (result.length < 3) return polygon;
	return result;
}

function douglasPeucker(points: Point[], tolerance: number): Point[] {
	if (points.length <= 2) return points;

	let maxDist = 0;
	let maxIdx = 0;
	const first = points[0];
	const last = points[points.length - 1];

	for (let i = 1; i < points.length - 1; i++) {
		const d = perpendicularDistance(points[i], first, last);
		if (d > maxDist) {
			maxDist = d;
			maxIdx = i;
		}
	}

	if (maxDist > tolerance) {
		const left = douglasPeucker(points.slice(0, maxIdx + 1), tolerance);
		const right = douglasPeucker(points.slice(maxIdx), tolerance);
		return [...left.slice(0, -1), ...right];
	}

	return [first, last];
}

function perpendicularDistance(point: Point, lineStart: Point, lineEnd: Point): number {
	const dx = lineEnd.x - lineStart.x;
	const dy = lineEnd.y - lineStart.y;
	const lenSq = dx * dx + dy * dy;

	if (lenSq === 0) {
		const ex = point.x - lineStart.x;
		const ey = point.y - lineStart.y;
		return Math.sqrt(ex * ex + ey * ey);
	}

	const num = Math.abs(dy * point.x - dx * point.y + lineEnd.x * lineStart.y - lineEnd.y * lineStart.x);
	return num / Math.sqrt(lenSq);
}
