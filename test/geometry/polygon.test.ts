import { describe, it, expect } from 'vitest';
import {
	boundingBox, polygonArea, translatePolygon, rotatePolygon,
	centroid, signedArea, getPlacedPolygons, toSVGPathD, transformPartPolygons
} from '$lib/geometry/polygon';
import type { Polygon, Part, PlacedPart } from '$lib/geometry/types';

const square: Polygon = [
	{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }
];

const triangle: Polygon = [
	{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 10 }
];

describe('boundingBox', () => {
	it('computes bounding box of a square', () => {
		const bb = boundingBox(square);
		expect(bb.minX).toBe(0); expect(bb.minY).toBe(0);
		expect(bb.maxX).toBe(10); expect(bb.maxY).toBe(10);
		expect(bb.width).toBe(10); expect(bb.height).toBe(10);
	});

	it('computes bounding box of a triangle', () => {
		const bb = boundingBox(triangle);
		expect(bb.width).toBe(20); expect(bb.height).toBe(10);
	});

	it('handles negative coordinates', () => {
		const poly: Polygon = [{ x: -5, y: -3 }, { x: 5, y: -3 }, { x: 0, y: 7 }];
		const bb = boundingBox(poly);
		expect(bb.minX).toBe(-5); expect(bb.maxY).toBe(7);
	});

	it('returns zero-size box for empty polygon', () => {
		const bb = boundingBox([]);
		expect(bb.width).toBe(0); expect(bb.height).toBe(0);
	});

	it('returns zero-size box for single point', () => {
		const bb = boundingBox([{ x: 3, y: 7 }]);
		expect(bb.width).toBe(0); expect(bb.height).toBe(0);
		expect(bb.minX).toBe(3); expect(bb.minY).toBe(7);
	});
});

describe('polygonArea', () => {
	it('computes area of a square', () => { expect(polygonArea(square)).toBeCloseTo(100); });
	it('computes area of a triangle', () => { expect(polygonArea(triangle)).toBeCloseTo(100); });
	it('returns positive area regardless of winding', () => {
		expect(polygonArea([...square].reverse())).toBeCloseTo(100);
	});
});

describe('signedArea', () => {
	it('is positive for CCW polygon', () => { expect(signedArea(square)).toBeGreaterThan(0); });
	it('is negative for CW polygon', () => { expect(signedArea([...square].reverse())).toBeLessThan(0); });
	it('is zero for empty polygon', () => { expect(signedArea([])).toBe(0); });
});

describe('translatePolygon', () => {
	it('translates all points', () => {
		const result = translatePolygon(square, 5, 3);
		expect(result[0]).toEqual({ x: 5, y: 3 });
		expect(result[2]).toEqual({ x: 15, y: 13 });
	});
	it('does not mutate original', () => {
		translatePolygon(square, 5, 3);
		expect(square[0]).toEqual({ x: 0, y: 0 });
	});
});

describe('rotatePolygon', () => {
	it('rotates 90 degrees around origin', () => {
		const result = rotatePolygon([{ x: 10, y: 0 }], Math.PI / 2, { x: 0, y: 0 });
		expect(result[0].x).toBeCloseTo(0); expect(result[0].y).toBeCloseTo(10);
	});

	it('returns copy without rotation when angle is 0', () => {
		const result = rotatePolygon(square, 0);
		expect(result).toEqual(square);
		expect(result).not.toBe(square);
	});

	it('rotates around centroid by default', () => {
		const result = rotatePolygon(square, Math.PI / 2);
		const c = centroid(square);
		const rc = centroid(result);
		expect(rc.x).toBeCloseTo(c.x); expect(rc.y).toBeCloseTo(c.y);
	});

	it('does not mutate original', () => {
		rotatePolygon(square, Math.PI / 4);
		expect(square[0]).toEqual({ x: 0, y: 0 });
	});
});

describe('centroid', () => {
	it('computes centroid of a square', () => {
		const c = centroid(square);
		expect(c.x).toBeCloseTo(5); expect(c.y).toBeCloseTo(5);
	});
	it('computes centroid of a triangle', () => {
		const c = centroid(triangle);
		expect(c.x).toBeCloseTo(10); expect(c.y).toBeCloseTo(10 / 3);
	});
	it('returns origin for empty polygon', () => {
		const c = centroid([]);
		expect(c.x).toBe(0); expect(c.y).toBe(0);
	});
	it('returns point for single-point polygon', () => {
		const c = centroid([{ x: 5, y: 7 }]);
		expect(c.x).toBe(5); expect(c.y).toBe(7);
	});
	it('handles collinear points without NaN', () => {
		const c = centroid([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }]);
		expect(Number.isFinite(c.x)).toBe(true);
		expect(Number.isFinite(c.y)).toBe(true);
	});
});

describe('getPlacedPolygons', () => {
	function makePP(w: number, h: number, x: number, y: number, rotation = 0): PlacedPart {
		const part: Part = { id: 'a', name: 'a', polygons: [[
			{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }
		]], sourceIndex: 0 };
		return { part, x, y, rotation };
	}

	it('returns polygon at correct position', () => {
		const polys = getPlacedPolygons(makePP(10, 10, 5, 5));
		expect(polys[0][0]).toEqual({ x: 5, y: 5 });
	});

	it('handles rotation', () => {
		const polys = getPlacedPolygons(makePP(10, 20, 0, 0, Math.PI / 2));
		const bb = boundingBox(polys[0]);
		expect(bb.width).toBeCloseTo(20);
		expect(bb.height).toBeCloseTo(10);
	});

	it('handles multiple polygons', () => {
		const part: Part = { id: 'a', name: 'a', polygons: [
			[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
			[{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }]
		], sourceIndex: 0 };
		const polys = getPlacedPolygons({ part, x: 0, y: 0, rotation: 0 });
		expect(polys).toHaveLength(2);
	});

	it('keeps a cutout in its position relative to the outer boundary', () => {
		// Outer square 0..100, cutout square 20..40 offset (20,20) from the corner.
		const part: Part = { id: 'a', name: 'a', polygons: [
			[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
			[{ x: 20, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 40 }, { x: 20, y: 40 }]
		], sourceIndex: 0 };

		const polys = getPlacedPolygons({ part, x: 200, y: 200, rotation: 0 });

		expect(boundingBox(polys[0]).minX).toBeCloseTo(200);
		expect(boundingBox(polys[0]).minY).toBeCloseTo(200);
		const inner = boundingBox(polys[1]);
		expect(inner.minX).toBeCloseTo(220);
		expect(inner.minY).toBeCloseTo(220);
		expect(inner.width).toBeCloseTo(20);
		expect(inner.height).toBeCloseTo(20);
	});

	it('rotates a part as a rigid body about a single center', () => {
		const polygons: Polygon[] = [
			[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
			[{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }]
		];

		const polys = transformPartPolygons(polygons, Math.PI / 2, 200, 200);

		expect(boundingBox(polys[0]).minX).toBeCloseTo(200);
		expect(boundingBox(polys[0]).minY).toBeCloseTo(200);
		// Cutout centroid (20,20) rotates 90deg about outer centroid (50,50):
		// relative (-30,-30) -> (30,-30) -> sheet center (250,250)+(30,-30)=(280,220).
		const inner = boundingBox(polys[1]);
		expect((inner.minX + inner.maxX) / 2).toBeCloseTo(280);
		expect((inner.minY + inner.maxY) / 2).toBeCloseTo(220);
	});
});

describe('toSVGPathD', () => {
	it('generates M/L/Z path', () => {
		const d = toSVGPathD([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
		expect(d).toContain('M 0 0');
		expect(d).toContain('L 10 0');
		expect(d).toContain('Z');
	});

	it('respects precision', () => {
		const d = toSVGPathD([{ x: 1.23456, y: 7.89012 }], 2);
		expect(d).toContain('1.23');
		expect(d).toContain('7.89');
	});

	it('returns empty for empty polygon', () => {
		expect(toSVGPathD([])).toBe('');
	});
});
