import { describe, it, expect } from 'vitest';
import { bottomLeftFill, getStripHeight, calculateUtilization } from './placement';
import type { Part, MaterialSheet } from '$lib/geometry/types';

function makePart(id: string, w: number, h: number): Part {
	return {
		id, name: id,
		polygons: [[{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]],
		sourceIndex: 0
	};
}

const sheet: MaterialSheet = { width: 100, height: 100 };

describe('bottomLeftFill', () => {
	it('places a single part at origin', () => {
		const result = bottomLeftFill([{ part: makePart('a', 10, 10), rotation: 0 }], sheet);
		expect(result).toHaveLength(1);
		expect(result[0].x).toBeCloseTo(0);
		expect(result[0].y).toBeCloseTo(0);
	});

	it('places two non-overlapping parts', () => {
		const result = bottomLeftFill(
			[{ part: makePart('a', 10, 10), rotation: 0 }, { part: makePart('b', 10, 10), rotation: 0 }],
			sheet
		);
		expect(result).toHaveLength(2);
		// Verify no BB overlap
		const [p1, p2] = result;
		const overlap = p1.x < p2.x + 10 && p1.x + 10 > p2.x && p1.y < p2.y + 10 && p1.y + 10 > p2.y;
		expect(overlap).toBe(false);
	});

	it('respects kerf spacing', () => {
		const result = bottomLeftFill(
			[{ part: makePart('a', 10, 10), rotation: 0 }, { part: makePart('b', 10, 10), rotation: 0 }],
			sheet, 5
		);
		expect(result).toHaveLength(2);
		const [p1, p2] = result;
		const gapX = Math.max(p2.x - (p1.x + 10), p1.x - (p2.x + 10));
		const gapY = Math.max(p2.y - (p1.y + 10), p1.y - (p2.y + 10));
		expect(Math.max(gapX, gapY)).toBeGreaterThanOrEqual(4.99);
	});

	it('skips parts that do not fit', () => {
		expect(bottomLeftFill([{ part: makePart('huge', 200, 200), rotation: 0 }], sheet)).toHaveLength(0);
	});

	it('places multiple parts filling the sheet', () => {
		const parts = Array.from({ length: 10 }, (_, i) => ({ part: makePart(`p${i}`, 10, 10), rotation: 0 }));
		expect(bottomLeftFill(parts, sheet)).toHaveLength(10);
	});
});

describe('getStripHeight', () => {
	it('returns 0 for empty placement', () => {
		expect(getStripHeight([])).toBe(0);
	});

	it('returns max Y of placed parts', () => {
		const placed = bottomLeftFill([{ part: makePart('a', 10, 20), rotation: 0 }], sheet);
		expect(getStripHeight(placed)).toBeCloseTo(20);
	});

	it('returns max Y across multiple parts', () => {
		const placed = bottomLeftFill([
			{ part: makePart('a', 10, 30), rotation: 0 },
			{ part: makePart('b', 10, 10), rotation: 0 }
		], sheet);
		expect(getStripHeight(placed)).toBeCloseTo(30);
	});
});

describe('calculateUtilization', () => {
	it('returns 0 for empty placement', () => {
		expect(calculateUtilization([], sheet)).toBe(0);
	});

	it('returns correct utilization for known case', () => {
		const placed = bottomLeftFill([{ part: makePart('a', 50, 50), rotation: 0 }], sheet);
		// 50*50 part area / (50 strip height * 100 width) = 0.5
		expect(calculateUtilization(placed, sheet)).toBeCloseTo(0.5);
	});
});
