import { describe, it, expect } from 'vitest';
import { computeNFP, computeIFP, pointInPolygon, polygonsOverlap, insetPolygon, polygonContainsPolygon } from '$lib/nesting/nfp';
import type { Polygon } from '$lib/geometry/types';
import { boundingBox } from '$lib/geometry/polygon';

const unitSquare: Polygon = [
	{ x: 0, y: 0 },
	{ x: 1, y: 0 },
	{ x: 1, y: 1 },
	{ x: 0, y: 1 }
];

const square2: Polygon = [
	{ x: 0, y: 0 },
	{ x: 2, y: 0 },
	{ x: 2, y: 2 },
	{ x: 0, y: 2 }
];

const square10: Polygon = [
	{ x: 0, y: 0 },
	{ x: 10, y: 0 },
	{ x: 10, y: 10 },
	{ x: 0, y: 10 }
];

describe('computeNFP', () => {
	it('computes NFP of two unit squares', () => {
		const nfp = computeNFP(unitSquare, unitSquare);
		expect(nfp.length).toBeGreaterThanOrEqual(4);
		const bb = boundingBox(nfp);
		expect(bb.minX).toBeCloseTo(-1);
		expect(bb.minY).toBeCloseTo(-1);
		expect(bb.maxX).toBeCloseTo(1);
		expect(bb.maxY).toBeCloseTo(1);
	});

	it('computes NFP for different sized squares', () => {
		const nfp = computeNFP(square2, unitSquare);
		const bb = boundingBox(nfp);
		expect(bb.minX).toBeCloseTo(-1);
		expect(bb.minY).toBeCloseTo(-1);
		expect(bb.maxX).toBeCloseTo(2);
		expect(bb.maxY).toBeCloseTo(2);
	});
});

describe('computeIFP', () => {
	it('computes inner fit for unit square in 10x10 bin', () => {
		const ifp = computeIFP(10, 10, unitSquare);
		expect(ifp).toHaveLength(4);
		const bb = boundingBox(ifp);
		expect(bb.minX).toBeCloseTo(0);
		expect(bb.minY).toBeCloseTo(0);
		expect(bb.maxX).toBeCloseTo(9);
		expect(bb.maxY).toBeCloseTo(9);
	});

	it('returns empty if part does not fit', () => {
		const largePart: Polygon = [
			{ x: 0, y: 0 },
			{ x: 20, y: 0 },
			{ x: 20, y: 20 },
			{ x: 0, y: 20 }
		];
		const ifp = computeIFP(10, 10, largePart);
		expect(ifp).toHaveLength(0);
	});
});

describe('pointInPolygon', () => {
	it('detects point inside square', () => {
		expect(pointInPolygon({ x: 0.5, y: 0.5 }, unitSquare)).toBe(true);
	});

	it('detects point outside square', () => {
		expect(pointInPolygon({ x: 2, y: 2 }, unitSquare)).toBe(false);
	});

	it('treats point on bottom edge as inside', () => {
		expect(pointInPolygon({ x: 0.5, y: 0 }, unitSquare)).toBe(true);
	});

	it('treats point on vertex as inside', () => {
		expect(pointInPolygon({ x: 0, y: 0 }, unitSquare)).toBe(true);
	});

	it('treats point on top edge as outside', () => {
		// Ray-casting is asymmetric: bottom edge is inside, top edge is outside
		expect(pointInPolygon({ x: 0.5, y: 1 }, unitSquare)).toBe(false);
	});
});

describe('insetPolygon', () => {
	it('shrinks a 10x10 square by 1 to an 8x8 square', () => {
		const inset = insetPolygon(square10, 1);
		expect(inset).toHaveLength(4);
		const bb = boundingBox(inset);
		expect(bb.minX).toBeCloseTo(1);
		expect(bb.minY).toBeCloseTo(1);
		expect(bb.maxX).toBeCloseTo(9);
		expect(bb.maxY).toBeCloseTo(9);
	});

	it('returns original polygon when distance is 0', () => {
		const inset = insetPolygon(square10, 0);
		expect(inset).toEqual(square10);
	});

	it('returns empty array when inset collapses the polygon', () => {
		expect(insetPolygon(square10, 5)).toHaveLength(0);
		expect(insetPolygon(square10, 10)).toHaveLength(0);
	});

	it('returns valid polygon just below collapse threshold', () => {
		const inset = insetPolygon(square10, 4);
		expect(inset).toHaveLength(4);
		const bb = boundingBox(inset);
		expect(bb.width).toBeGreaterThan(0);
		expect(bb.height).toBeGreaterThan(0);
	});

	it('works on a triangle', () => {
		const triangle: Polygon = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 5, y: 10 }
		];
		const inset = insetPolygon(triangle, 1);
		expect(inset.length).toBe(3);
		const bb = boundingBox(inset);
		expect(bb.width).toBeLessThan(10);
		expect(bb.height).toBeLessThan(10);
	});
});

describe('polygonContainsPolygon', () => {
	it('detects a small square inside a large square', () => {
		const inner: Polygon = [
			{ x: 1, y: 1 },
			{ x: 4, y: 1 },
			{ x: 4, y: 4 },
			{ x: 1, y: 4 }
		];
		expect(polygonContainsPolygon(square10, inner)).toBe(true);
	});

	it('rejects a square that overflows', () => {
		const inner: Polygon = [
			{ x: 8, y: 8 },
			{ x: 12, y: 8 },
			{ x: 12, y: 12 },
			{ x: 8, y: 12 }
		];
		expect(polygonContainsPolygon(square10, inner)).toBe(false);
	});

	it('rejects a completely outside square', () => {
		const inner: Polygon = [
			{ x: 20, y: 20 },
			{ x: 25, y: 20 },
			{ x: 25, y: 25 },
			{ x: 20, y: 25 }
		];
		expect(polygonContainsPolygon(square10, inner)).toBe(false);
	});

	it('accepts a square sharing bottom edge with outer (bottom boundary is inside)', () => {
		const inner: Polygon = [
			{ x: 2, y: 0 },
			{ x: 8, y: 0 },
			{ x: 8, y: 4 },
			{ x: 2, y: 4 }
		];
		expect(polygonContainsPolygon(square10, inner)).toBe(true);
	});

	it('rejects a square sharing top edge with outer (top boundary is outside)', () => {
		const inner: Polygon = [
			{ x: 2, y: 6 },
			{ x: 8, y: 6 },
			{ x: 8, y: 10 },
			{ x: 2, y: 10 }
		];
		expect(polygonContainsPolygon(square10, inner)).toBe(false);
	});
});

describe('polygonsOverlap', () => {
	it('detects overlapping squares', () => {
		const shifted: Polygon = unitSquare.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
		expect(polygonsOverlap(unitSquare, shifted)).toBe(true);
	});

	it('detects non-overlapping squares', () => {
		const far: Polygon = unitSquare.map((p) => ({ x: p.x + 5, y: p.y + 5 }));
		expect(polygonsOverlap(unitSquare, far)).toBe(false);
	});

	it('touching squares do not overlap', () => {
		const adjacent: Polygon = unitSquare.map((p) => ({ x: p.x + 1, y: p.y }));
		expect(polygonsOverlap(unitSquare, adjacent)).toBe(false);
	});
});
