import type { Point, Polygon, Part, PlacedPart, MaterialSheet } from '$lib/geometry/types';
import { boundingBox, rotatePolygon, translatePolygon, getPlacedPolygons } from '$lib/geometry/polygon';
import type { BoundingBox } from '$lib/geometry/types';
import { polygonsOverlap } from './nfp';

interface CachedPlacement {
	pp: PlacedPart;
	polygon: Polygon;
	bb: BoundingBox;
}

export function bottomLeftFill(
	parts: { part: Part; rotation: number }[],
	sheet: MaterialSheet,
	kerf: number = 0
): PlacedPart[] {
	const placed: PlacedPart[] = [];
	const cache: CachedPlacement[] = [];

	for (const { part, rotation } of parts) {
		const rawPoly = part.polygons[0];
		const rotated = rotatePolygon(rawPoly, rotation);
		const bb = boundingBox(rotated);
		const normalized = translatePolygon(rotated, -bb.minX, -bb.minY);
		// After normalizing to origin, partBB = { width: bb.width, height: bb.height }
		const partW = bb.width;
		const partH = bb.height;

		if (partW > sheet.width || partH > sheet.height) {
			continue;
		}

		const position = findBestPosition(normalized, { width: partW, height: partH }, cache, sheet, kerf);
		if (position) {
			const pp: PlacedPart = { part, x: position.x, y: position.y, rotation };
			placed.push(pp);
			const finalPoly = translatePolygon(normalized, position.x, position.y);
			// Compute final BB directly from known position + dimensions
			const finalBB: BoundingBox = {
				minX: position.x, minY: position.y,
				maxX: position.x + partW, maxY: position.y + partH,
				width: partW, height: partH
			};
			cache.push({ pp, polygon: finalPoly, bb: finalBB });
		}
	}

	return placed;
}

function findBestPosition(
	normalizedPoly: Polygon,
	partBB: { width: number; height: number },
	cache: CachedPlacement[],
	sheet: MaterialSheet,
	kerf: number
): Point | null {
	const maxX = sheet.width - partBB.width;
	const maxY = sheet.height - partBB.height;

	// Try origin first (common fast path for first part)
	if (!hasCollision(normalizedPoly, 0, 0, cache, sheet, kerf)) {
		return { x: 0, y: 0 };
	}

	// Try positions adjacent to already-placed parts (fast, targeted)
	// This is the primary placement strategy
	const candidates: { x: number; y: number; score: number }[] = [];

	for (const cp of cache) {
		// Generate candidate positions along edges of placed parts
		const positions = [
			// Right of placed part
			{ x: cp.bb.maxX + kerf, y: cp.bb.minY },
			// Below placed part
			{ x: cp.bb.minX, y: cp.bb.maxY + kerf },
			// Right-below corner
			{ x: cp.bb.maxX + kerf, y: cp.bb.maxY + kerf },
			// Aligned right, at bottom of sheet usage
			{ x: cp.bb.maxX + kerf, y: 0 },
			// Aligned at x=0, below placed part
			{ x: 0, y: cp.bb.maxY + kerf },
		];

		for (const pos of positions) {
			if (
				pos.x >= 0 && pos.y >= 0 &&
				pos.x + partBB.width <= sheet.width &&
				pos.y + partBB.height <= sheet.height &&
				!hasCollision(normalizedPoly, pos.x, pos.y, cache, sheet, kerf)
			) {
				// Score: prefer bottom-left (lower y first, then lower x)
				candidates.push({ ...pos, score: pos.y * sheet.width + pos.x });
			}
		}
	}

	if (candidates.length > 0) {
		candidates.sort((a, b) => a.score - b.score);
		return { x: candidates[0].x, y: candidates[0].y };
	}

	// Fallback: coarse grid scan (only if edge-adjacent failed)
	const step = Math.max(partBB.width, partBB.height, 10);
	for (let y = 0; y <= maxY; y += step) {
		for (let x = 0; x <= maxX; x += step) {
			if (!hasCollision(normalizedPoly, x, y, cache, sheet, kerf)) {
				return { x, y };
			}
		}
	}

	return null;
}

function hasCollision(
	poly: Polygon,
	x: number,
	y: number,
	cache: CachedPlacement[],
	sheet: MaterialSheet,
	kerf: number
): boolean {
	const translated = translatePolygon(poly, x, y);
	const bb = boundingBox(translated);

	if (bb.minX < 0 || bb.minY < 0 || bb.maxX > sheet.width || bb.maxY > sheet.height) {
		return true;
	}

	for (const cp of cache) {
		if (
			bb.maxX + kerf <= cp.bb.minX ||
			bb.minX >= cp.bb.maxX + kerf ||
			bb.maxY + kerf <= cp.bb.minY ||
			bb.minY >= cp.bb.maxY + kerf
		) {
			continue;
		}

		// When kerf > 0, bounding-box overlap (with kerf margin) is treated as collision.
		// This is an intentional approximation: exact polygon overlap checking with kerf
		// would require offsetting polygons, which is expensive. The tradeoff is slightly
		// less dense packing when kerf is non-zero, but much faster placement.
		if (kerf > 0) {
			return true;
		}

		if (polygonsOverlap(translated, cp.polygon)) {
			return true;
		}
	}

	return false;
}

/** Compute strip height and utilization in a single pass */
export function computeSheetStats(placed: PlacedPart[], sheet: MaterialSheet): { stripHeight: number; utilization: number } {
	if (placed.length === 0) return { stripHeight: 0, utilization: 0 };

	let maxY = 0;
	let partsArea = 0;

	for (const pp of placed) {
		const polys = getPlacedPolygons(pp);
		for (const poly of polys) {
			const bb = boundingBox(poly);
			if (bb.maxY > maxY) maxY = bb.maxY;
			partsArea += bb.width * bb.height;
		}
	}

	const usedArea = maxY * sheet.width;
	const utilization = usedArea === 0 ? 0 : Math.min(1, partsArea / usedArea);

	return { stripHeight: maxY, utilization };
}

export function calculateUtilization(placed: PlacedPart[], sheet: MaterialSheet): number {
	return computeSheetStats(placed, sheet).utilization;
}

export function getStripHeight(placed: PlacedPart[]): number {
	if (placed.length === 0) return 0;
	let maxY = 0;
	for (const pp of placed) {
		const polys = getPlacedPolygons(pp);
		for (const poly of polys) {
			const bb = boundingBox(poly);
			if (bb.maxY > maxY) maxY = bb.maxY;
		}
	}
	return maxY;
}
