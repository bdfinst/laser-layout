import type { Part, Polygon } from './types';
import { boundingBox, polygonArea } from './polygon';

export interface DedupResult {
	uniqueParts: Part[];
	quantities: Map<string, number>;
}

/**
 * Deduplicate parts that have identical geometry.
 * @param tolerancePct — matching tolerance as a fraction (0.01 = 1%, 0.001 = 0.1%)
 */
export function deduplicateParts(parts: Part[], tolerancePct: number = 0.01): DedupResult {
	if (parts.length === 0) return { uniqueParts: [], quantities: new Map() };

	const groups: { part: Part; count: number }[] = [];

	for (const part of parts) {
		const matchIdx = groups.findIndex((g) => shapesMatch(g.part, part, tolerancePct));
		if (matchIdx >= 0) {
			groups[matchIdx].count++;
		} else {
			groups.push({ part, count: 1 });
		}
	}

	const uniqueParts: Part[] = [];
	const quantities = new Map<string, number>();

	for (let i = 0; i < groups.length; i++) {
		const { part, count } = groups[i];
		const dedupPart: Part = {
			...part,
			id: `part-${i}`,
			sourceIndex: i
		};
		uniqueParts.push(dedupPart);
		quantities.set(dedupPart.id, count);
	}

	return { uniqueParts, quantities };
}

function shapesMatch(a: Part, b: Part, tolerancePct: number): boolean {
	if (a.polygons.length !== b.polygons.length) return false;

	for (let i = 0; i < a.polygons.length; i++) {
		if (!polygonsMatch(a.polygons[i], b.polygons[i], tolerancePct)) return false;
	}

	return true;
}

function polygonsMatch(a: Polygon, b: Polygon, tolerancePct: number): boolean {
	if (a.length !== b.length) return false;

	const bbA = boundingBox(a);
	const bbB = boundingBox(b);
	const tolerance = Math.max(bbA.width, bbA.height, bbB.width, bbB.height) * tolerancePct;

	if (Math.abs(bbA.width - bbB.width) > tolerance) return false;
	if (Math.abs(bbA.height - bbB.height) > tolerance) return false;

	const areaA = polygonArea(a);
	const areaB = polygonArea(b);
	if (Math.abs(areaA - areaB) > tolerance * tolerance) return false;

	const normA = a.map((p) => ({ x: p.x - bbA.minX, y: p.y - bbA.minY }));
	const normB = b.map((p) => ({ x: p.x - bbB.minX, y: p.y - bbB.minY }));

	for (let i = 0; i < normA.length; i++) {
		if (Math.abs(normA[i].x - normB[i].x) > tolerance) return false;
		if (Math.abs(normA[i].y - normB[i].y) > tolerance) return false;
	}

	return true;
}
