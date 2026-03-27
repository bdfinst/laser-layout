import type { Point, Polygon, BoundingBox, PlacedPart } from './types';

export function boundingBox(polygon: Polygon): BoundingBox {
	if (polygon.length === 0) {
		return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
	}
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of polygon) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Signed area using the shoelace formula. Positive = CCW, negative = CW. */
export function signedArea(polygon: Polygon): number {
	let area = 0;
	const n = polygon.length;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		area += polygon[i].x * polygon[j].y;
		area -= polygon[j].x * polygon[i].y;
	}
	return area / 2;
}

/** Absolute area of a polygon */
export function polygonArea(polygon: Polygon): number {
	return Math.abs(signedArea(polygon));
}

/** Geometric centroid of a polygon */
export function centroid(polygon: Polygon): Point {
	const n = polygon.length;
	if (n === 0) return { x: 0, y: 0 };
	if (n <= 2) {
		const sx = polygon.reduce((s, p) => s + p.x, 0);
		const sy = polygon.reduce((s, p) => s + p.y, 0);
		return { x: sx / n, y: sy / n };
	}
	let cx = 0;
	let cy = 0;
	const a = signedArea(polygon);
	if (Math.abs(a) < 1e-10) {
		// Degenerate (collinear) — use simple average
		const sx = polygon.reduce((s, p) => s + p.x, 0);
		const sy = polygon.reduce((s, p) => s + p.y, 0);
		return { x: sx / n, y: sy / n };
	}
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		const cross = polygon[i].x * polygon[j].y - polygon[j].x * polygon[i].y;
		cx += (polygon[i].x + polygon[j].x) * cross;
		cy += (polygon[i].y + polygon[j].y) * cross;
	}
	const factor = 1 / (6 * a);
	return { x: cx * factor, y: cy * factor };
}

/** Translate a polygon by (dx, dy), returns new polygon */
export function translatePolygon(polygon: Polygon, dx: number, dy: number): Polygon {
	return polygon.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

/** Rotate a polygon by angle (radians) around a center point. Defaults to centroid. */
export function rotatePolygon(polygon: Polygon, angle: number, center?: Point): Polygon {
	// Fast path: no rotation needed
	if (Math.abs(angle) < 1e-10) {
		return polygon.map((p) => ({ x: p.x, y: p.y }));
	}
	const c = center ?? centroid(polygon);
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	return polygon.map((p) => {
		const dx = p.x - c.x;
		const dy = p.y - c.y;
		return {
			x: c.x + dx * cos - dy * sin,
			y: c.y + dx * sin + dy * cos
		};
	});
}

/** Get the transformed polygons for a placed part (rotate, normalize, translate) */
export function getPlacedPolygons(pp: PlacedPart): Polygon[] {
	return pp.part.polygons.map((poly) => {
		const rotated = rotatePolygon(poly, pp.rotation);
		const bb = boundingBox(rotated);
		const normalized = translatePolygon(rotated, -bb.minX, -bb.minY);
		return translatePolygon(normalized, pp.x, pp.y);
	});
}

/** Convert a polygon to an SVG path d attribute string */
export function toSVGPathD(polygon: Polygon, precision?: number): string {
	if (polygon.length === 0) return '';
	const fmt = (n: number) => precision !== undefined ? n.toFixed(precision) : String(n);
	const parts = [`M ${fmt(polygon[0].x)} ${fmt(polygon[0].y)}`];
	for (let i = 1; i < polygon.length; i++) {
		parts.push(`L ${fmt(polygon[i].x)} ${fmt(polygon[i].y)}`);
	}
	parts.push('Z');
	return parts.join(' ');
}
