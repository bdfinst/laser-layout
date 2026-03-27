import { describe, it, expect } from 'vitest';
import { computeNFP, computeIFP, pointInPolygon, polygonsOverlap } from './nfp';
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

describe('computeNFP', () => {
	it('computes NFP of two unit squares', () => {
		const nfp = computeNFP(unitSquare, unitSquare);
		expect(nfp.length).toBeGreaterThanOrEqual(4);
		const bb = boundingBox(nfp);
		// NFP of two unit squares should span from -1 to 1 in both axes
		expect(bb.minX).toBeCloseTo(-1);
		expect(bb.minY).toBeCloseTo(-1);
		expect(bb.maxX).toBeCloseTo(1);
		expect(bb.maxY).toBeCloseTo(1);
	});

	it('computes NFP for different sized squares', () => {
		const nfp = computeNFP(square2, unitSquare);
		const bb = boundingBox(nfp);
		// NFP should span from -1 to 2 in both axes
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

	it('handles point on edge consistently', () => {
		// Ray casting may return true or false for boundary — just verify no crash
		const result = pointInPolygon({ x: 0.5, y: 0 }, unitSquare);
		expect(typeof result).toBe('boolean');
	});

	it('handles point on vertex consistently', () => {
		const result = pointInPolygon({ x: 0, y: 0 }, unitSquare);
		expect(typeof result).toBe('boolean');
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
