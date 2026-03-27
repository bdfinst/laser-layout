import { describe, it, expect } from 'vitest';
import {
	IDENTITY, multiplyMatrices, applyMatrix, applyMatrixToPolygon,
	cubicBezier, quadraticBezier, parseTransformAttr
} from '$lib/geometry/affine';

describe('IDENTITY', () => {
	it('does not transform a point', () => {
		expect(applyMatrix(IDENTITY, { x: 5, y: 7 })).toEqual({ x: 5, y: 7 });
	});
});

describe('multiplyMatrices', () => {
	it('identity * identity = identity', () => {
		const r = multiplyMatrices(IDENTITY, IDENTITY);
		expect(r).toEqual(IDENTITY);
	});

	it('composes translate + scale', () => {
		const translate = { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 };
		const scale = { a: 2, b: 0, c: 0, d: 3, e: 0, f: 0 };
		const r = multiplyMatrices(translate, scale);
		const p = applyMatrix(r, { x: 1, y: 1 });
		// scale first: (2, 3), then translate: (12, 23)
		expect(p.x).toBeCloseTo(12);
		expect(p.y).toBeCloseTo(23);
	});
});

describe('applyMatrixToPolygon', () => {
	it('translates all points', () => {
		const m = { a: 1, b: 0, c: 0, d: 1, e: 5, f: 10 };
		const poly = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
		const result = applyMatrixToPolygon(m, poly);
		expect(result[0]).toEqual({ x: 5, y: 10 });
		expect(result[1]).toEqual({ x: 6, y: 11 });
	});
});

describe('cubicBezier', () => {
	it('produces correct number of points', () => {
		const pts = cubicBezier({ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 3, y: 2 }, { x: 4, y: 0 }, 8);
		expect(pts).toHaveLength(8);
	});

	it('endpoints match', () => {
		const pts = cubicBezier({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 0 }, 10);
		expect(pts[pts.length - 1].x).toBeCloseTo(3);
		expect(pts[pts.length - 1].y).toBeCloseTo(0);
	});
});

describe('quadraticBezier', () => {
	it('produces correct number of points', () => {
		const pts = quadraticBezier({ x: 0, y: 0 }, { x: 5, y: 10 }, { x: 10, y: 0 }, 8);
		expect(pts).toHaveLength(8);
	});

	it('endpoint matches', () => {
		const pts = quadraticBezier({ x: 0, y: 0 }, { x: 5, y: 10 }, { x: 10, y: 0 }, 10);
		expect(pts[pts.length - 1].x).toBeCloseTo(10);
		expect(pts[pts.length - 1].y).toBeCloseTo(0);
	});
});

describe('parseTransformAttr', () => {
	it('returns identity for null', () => {
		expect(parseTransformAttr(null)).toEqual(IDENTITY);
	});

	it('returns identity for empty string', () => {
		expect(parseTransformAttr('')).toEqual(IDENTITY);
	});

	it('parses translate', () => {
		const m = parseTransformAttr('translate(10, 20)');
		const p = applyMatrix(m, { x: 0, y: 0 });
		expect(p.x).toBeCloseTo(10);
		expect(p.y).toBeCloseTo(20);
	});

	it('parses scale', () => {
		const m = parseTransformAttr('scale(2)');
		const p = applyMatrix(m, { x: 5, y: 3 });
		expect(p.x).toBeCloseTo(10);
		expect(p.y).toBeCloseTo(6);
	});

	it('parses scale with two values', () => {
		const m = parseTransformAttr('scale(2, 3)');
		const p = applyMatrix(m, { x: 1, y: 1 });
		expect(p.x).toBeCloseTo(2);
		expect(p.y).toBeCloseTo(3);
	});

	it('parses rotate', () => {
		const m = parseTransformAttr('rotate(90)');
		const p = applyMatrix(m, { x: 10, y: 0 });
		expect(p.x).toBeCloseTo(0);
		expect(p.y).toBeCloseTo(10);
	});

	it('parses rotate with center', () => {
		const m = parseTransformAttr('rotate(90, 5, 5)');
		const p = applyMatrix(m, { x: 10, y: 5 });
		expect(p.x).toBeCloseTo(5);
		expect(p.y).toBeCloseTo(10);
	});

	it('parses matrix', () => {
		const m = parseTransformAttr('matrix(1 0 0 1 10 20)');
		const p = applyMatrix(m, { x: 0, y: 0 });
		expect(p.x).toBeCloseTo(10);
		expect(p.y).toBeCloseTo(20);
	});

	it('composes multiple transforms', () => {
		const m = parseTransformAttr('translate(10, 0) scale(2)');
		const p = applyMatrix(m, { x: 1, y: 1 });
		// scale(2): (2, 2), then translate(10,0): (12, 2)
		expect(p.x).toBeCloseTo(12);
		expect(p.y).toBeCloseTo(2);
	});
});
