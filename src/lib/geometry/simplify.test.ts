import { describe, it, expect } from 'vitest';
import { simplifyPolygon } from './simplify';
import type { Polygon } from './types';

describe('simplifyPolygon', () => {
	it('returns polygon unchanged if <= 3 points', () => {
		const tri: Polygon = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }];
		expect(simplifyPolygon(tri, 100)).toEqual(tri);
	});

	it('returns polygon unchanged if <= 3 points after simplification', () => {
		const line: Polygon = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }];
		// All collinear — would simplify to 2 points, but fallback returns original
		expect(simplifyPolygon(line, 1)).toEqual(line);
	});

	it('keeps all points at tolerance 0', () => {
		const poly: Polygon = [
			{ x: 0, y: 0 }, { x: 5, y: 1 }, { x: 10, y: 0 },
			{ x: 10, y: 10 }, { x: 0, y: 10 }
		];
		const result = simplifyPolygon(poly, 0);
		expect(result).toEqual(poly);
	});

	it('removes redundant midpoints on straight edges', () => {
		// Square with extra midpoints on each edge
		const poly: Polygon = [
			{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 },
			{ x: 10, y: 5 }, { x: 10, y: 10 },
			{ x: 5, y: 10 }, { x: 0, y: 10 },
			{ x: 0, y: 5 }
		];
		const result = simplifyPolygon(poly, 0.1);
		expect(result.length).toBeLessThan(poly.length);
		expect(result.length).toBeGreaterThanOrEqual(3);
	});

	it('preserves corners with high tolerance', () => {
		const poly: Polygon = [
			{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }
		];
		const result = simplifyPolygon(poly, 100);
		// 4 points is already minimal for a square
		expect(result.length).toBeGreaterThanOrEqual(3);
	});

	it('reduces complex polygon', () => {
		// Create a circle-like polygon with many points
		const poly: Polygon = [];
		for (let i = 0; i < 100; i++) {
			const angle = (2 * Math.PI * i) / 100;
			poly.push({ x: 50 + 50 * Math.cos(angle), y: 50 + 50 * Math.sin(angle) });
		}
		const result = simplifyPolygon(poly, 2);
		expect(result.length).toBeLessThan(poly.length);
		expect(result.length).toBeGreaterThanOrEqual(3);
	});
});
