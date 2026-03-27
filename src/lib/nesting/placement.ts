import type { Point, Polygon, Part, PlacedPart, MaterialSheet } from '$lib/geometry/types';
import { boundingBox, rotatePolygon, translatePolygon, getPlacedPolygons } from '$lib/geometry/polygon';
import type { BoundingBox } from '$lib/geometry/types';
import { polygonsOverlap, insetPolygon as computeInsetPolygon, polygonContainsPolygon } from './nfp';

interface CachedPlacement {
	pp: PlacedPart;
	polygon: Polygon;
	bb: BoundingBox;
}

interface CachedHole {
	sourcePlacementIndex: number;
	holePolygon: Polygon;
	holeBB: BoundingBox;
	insetPoly: Polygon;
	insetBB: BoundingBox;
	innerPlacements: CachedPlacement[];
}

interface PlacementResult {
	position: Point;
	hole: CachedHole | null;
}

export function bottomLeftFill(
	parts: { part: Part; rotation: number }[],
	sheet: MaterialSheet,
	kerf: number = 0
): PlacedPart[] {
	const placed: PlacedPart[] = [];
	const cache: CachedPlacement[] = [];
	let holes: CachedHole[] = [];

	for (const { part, rotation } of parts) {
		const outerPoly = part.polygons[0];
		const rotated = rotatePolygon(outerPoly, rotation);
		const bb = boundingBox(rotated);
		const normalized = translatePolygon(rotated, -bb.minX, -bb.minY);
		const partW = bb.width;
		const partH = bb.height;

		if (partW > sheet.width || partH > sheet.height) {
			continue;
		}

		const result = findBestPosition(normalized, { width: partW, height: partH }, cache, holes, sheet, kerf);
		if (result) {
			const pp: PlacedPart = { part, x: result.position.x, y: result.position.y, rotation };
			placed.push(pp);
			const finalPoly = translatePolygon(normalized, result.position.x, result.position.y);
			const finalBB: BoundingBox = {
				minX: result.position.x, minY: result.position.y,
				maxX: result.position.x + partW, maxY: result.position.y + partH,
				width: partW, height: partH
			};
			const cp: CachedPlacement = { pp, polygon: finalPoly, bb: finalBB };
			cache.push(cp);

			if (result.hole) {
				result.hole.innerPlacements.push(cp);
			} else {
				// Only extract holes from parts placed on the sheet (no recursive nesting)
				const newHoles = extractHoles(part, rotation, result.position, cache.length - 1, kerf);
				holes = [...holes, ...newHoles];
			}
		}
	}

	return placed;
}

function extractHoles(
	part: Part,
	rotation: number,
	position: Point,
	sourcePlacementIndex: number,
	kerf: number
): CachedHole[] {
	if (part.polygons.length <= 1) return [];

	// Compute parent transform once for all holes
	const parentRotated = rotatePolygon(part.polygons[0], rotation);
	const parentBB = boundingBox(parentRotated);
	const result: CachedHole[] = [];

	for (let i = 1; i < part.polygons.length; i++) {
		const rotated = rotatePolygon(part.polygons[i], rotation);

		// Transform hole to sheet coordinates: rotate, offset relative to parent's origin, translate
		const sheetHole = translatePolygon(
			translatePolygon(rotated, -parentBB.minX, -parentBB.minY),
			position.x, position.y
		);
		const sheetHoleBB = boundingBox(sheetHole);

		const inset = kerf > 0 ? computeInsetPolygon(sheetHole, kerf) : sheetHole;
		if (inset.length === 0) continue; // hole too small after kerf inset

		result.push({
			sourcePlacementIndex,
			holePolygon: sheetHole,
			holeBB: sheetHoleBB,
			insetPoly: inset,
			insetBB: boundingBox(inset),
			innerPlacements: []
		});
	}

	return result;
}

// --- Phase helpers for findBestPosition ---

function tryHolePlacement(
	normalizedPoly: Polygon,
	partBB: { width: number; height: number },
	holes: CachedHole[],
	kerf: number
): PlacementResult | null {
	const holeCandidates: { x: number; y: number; score: number; hole: CachedHole }[] = [];

	for (const hole of holes) {
		if (partBB.width > hole.insetBB.width || partBB.height > hole.insetBB.height) continue;

		const hx = hole.insetBB.minX;
		const hy = hole.insetBB.minY;
		const mx = hole.insetBB.maxX - partBB.width;
		const my = hole.insetBB.maxY - partBB.height;

		const corners = [
			{ x: hx, y: hy },
			{ x: mx, y: hy },
			{ x: hx, y: my },
			{ x: mx, y: my },
			{ x: (hx + mx) / 2, y: (hy + my) / 2 },
		];

		for (const pos of corners) {
			const translated = translatePolygon(normalizedPoly, pos.x, pos.y);
			if (!polygonContainsPolygon(hole.insetPoly, translated)) continue;

			const translatedBB: BoundingBox = {
				minX: pos.x, minY: pos.y,
				maxX: pos.x + partBB.width, maxY: pos.y + partBB.height,
				width: partBB.width, height: partBB.height
			};
			if (checkOverlap(translated, translatedBB, hole.innerPlacements, kerf)) continue;

			const holeArea = hole.holeBB.width * hole.holeBB.height;
			holeCandidates.push({ ...pos, score: -1e9 + holeArea, hole });
		}
	}

	if (holeCandidates.length === 0) return null;

	holeCandidates.sort((a, b) => a.score - b.score);
	const best = holeCandidates[0];
	return { position: { x: best.x, y: best.y }, hole: best.hole };
}

function tryAdjacentPositions(
	normalizedPoly: Polygon,
	partBB: { width: number; height: number },
	cache: CachedPlacement[],
	sheet: MaterialSheet,
	kerf: number
): PlacementResult | null {
	const candidates: { x: number; y: number; score: number }[] = [];

	for (const cp of cache) {
		const positions = [
			{ x: cp.bb.maxX + kerf, y: cp.bb.minY },
			{ x: cp.bb.minX, y: cp.bb.maxY + kerf },
			{ x: cp.bb.maxX + kerf, y: cp.bb.maxY + kerf },
			{ x: cp.bb.maxX + kerf, y: 0 },
			{ x: 0, y: cp.bb.maxY + kerf },
		];

		for (const pos of positions) {
			if (
				pos.x >= 0 && pos.y >= 0 &&
				pos.x + partBB.width <= sheet.width &&
				pos.y + partBB.height <= sheet.height &&
				!hasCollision(normalizedPoly, pos.x, pos.y, cache, sheet, kerf)
			) {
				candidates.push({ ...pos, score: pos.y * sheet.width + pos.x });
			}
		}
	}

	if (candidates.length === 0) return null;

	candidates.sort((a, b) => a.score - b.score);
	return { position: { x: candidates[0].x, y: candidates[0].y }, hole: null };
}

function tryGridFallback(
	normalizedPoly: Polygon,
	partBB: { width: number; height: number },
	cache: CachedPlacement[],
	sheet: MaterialSheet,
	kerf: number
): PlacementResult | null {
	const maxX = sheet.width - partBB.width;
	const maxY = sheet.height - partBB.height;
	const step = Math.max(partBB.width, partBB.height, 10);

	for (let y = 0; y <= maxY; y += step) {
		for (let x = 0; x <= maxX; x += step) {
			if (!hasCollision(normalizedPoly, x, y, cache, sheet, kerf)) {
				return { position: { x, y }, hole: null };
			}
		}
	}

	return null;
}

function findBestPosition(
	normalizedPoly: Polygon,
	partBB: { width: number; height: number },
	cache: CachedPlacement[],
	holes: CachedHole[],
	sheet: MaterialSheet,
	kerf: number
): PlacementResult | null {
	// Phase 0: Try placing inside holes (always preferred — doesn't increase strip height)
	const holeResult = tryHolePlacement(normalizedPoly, partBB, holes, kerf);
	if (holeResult) return holeResult;

	// Phase 1: Try origin first (common fast path for first part)
	if (!hasCollision(normalizedPoly, 0, 0, cache, sheet, kerf)) {
		return { position: { x: 0, y: 0 }, hole: null };
	}

	// Phase 2: Try positions adjacent to already-placed parts
	const adjacentResult = tryAdjacentPositions(normalizedPoly, partBB, cache, sheet, kerf);
	if (adjacentResult) return adjacentResult;

	// Phase 3: Fallback coarse grid scan
	return tryGridFallback(normalizedPoly, partBB, cache, sheet, kerf);
}

// --- Collision detection ---

/** Check if a translated polygon overlaps any placement in a list (shared by hole and sheet collision). */
function checkOverlap(
	translatedPoly: Polygon,
	translatedBB: BoundingBox,
	placements: CachedPlacement[],
	kerf: number
): boolean {
	for (const cp of placements) {
		if (
			translatedBB.maxX + kerf <= cp.bb.minX ||
			translatedBB.minX >= cp.bb.maxX + kerf ||
			translatedBB.maxY + kerf <= cp.bb.minY ||
			translatedBB.minY >= cp.bb.maxY + kerf
		) {
			continue;
		}

		// When kerf > 0, bounding-box overlap (with kerf margin) is treated as collision.
		// This is an intentional approximation: exact polygon overlap checking with kerf
		// would require offsetting polygons, which is expensive. The tradeoff is slightly
		// less dense packing when kerf is non-zero, but much faster placement.
		if (kerf > 0) return true;

		if (polygonsOverlap(translatedPoly, cp.polygon)) {
			return true;
		}
	}

	return false;
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

	return checkOverlap(translated, bb, cache, kerf);
}

// --- Stats ---

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
