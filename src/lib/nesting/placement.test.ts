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

function makePartWithHole(
	id: string,
	outerW: number, outerH: number,
	holeX: number, holeY: number, holeW: number, holeH: number
): Part {
	return {
		id, name: id,
		polygons: [
			[{ x: 0, y: 0 }, { x: outerW, y: 0 }, { x: outerW, y: outerH }, { x: 0, y: outerH }],
			[{ x: holeX, y: holeY }, { x: holeX + holeW, y: holeY }, { x: holeX + holeW, y: holeY + holeH }, { x: holeX, y: holeY + holeH }]
		],
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

describe('hole-aware placement', () => {
	it('places a small part inside a large part hole', () => {
		// Hole at (5,5) size 40x40 — large enough that all candidates are strictly interior
		const ring = makePartWithHole('ring', 50, 50, 5, 5, 40, 40);
		const small = makePart('small', 10, 10);
		const result = bottomLeftFill(
			[{ part: ring, rotation: 0 }, { part: small, rotation: 0 }],
			sheet
		);
		expect(result).toHaveLength(2);
		const sp = result[1];
		expect(sp.x).toBeGreaterThanOrEqual(5);
		expect(sp.y).toBeGreaterThanOrEqual(5);
		expect(sp.x + 10).toBeLessThanOrEqual(45);
		expect(sp.y + 10).toBeLessThanOrEqual(45);
	});

	it('does not place a part too large for the hole inside it', () => {
		// 20x20 hole, 25x25 part — rejected by BB pre-filter
		const ring = makePartWithHole('ring', 50, 50, 15, 15, 20, 20);
		const big = makePart('big', 25, 25);
		const result = bottomLeftFill(
			[{ part: ring, rotation: 0 }, { part: big, rotation: 0 }],
			sheet
		);
		expect(result).toHaveLength(2);
		const bp = result[1];
		const insideHole = bp.x >= 15 && bp.y >= 15 && bp.x + 25 <= 35 && bp.y + 25 <= 35;
		expect(insideHole).toBe(false);
	});

	it('rejects a part that fits in hole BB but not after kerf inset', () => {
		// 20x20 hole with kerf=1 → inset to ~18x18. A 19x19 part fits the hole BB
		// but not the inset BB, exercising the kerf-aware rejection.
		const ring = makePartWithHole('ring', 50, 50, 15, 15, 20, 20);
		const nearFit = makePart('nearfit', 19, 19);
		const result = bottomLeftFill(
			[{ part: ring, rotation: 0 }, { part: nearFit, rotation: 0 }],
			sheet, 1
		);
		expect(result).toHaveLength(2);
		const nf = result[1];
		const insideHole = nf.x >= 15 && nf.y >= 15 && nf.x + 19 <= 35 && nf.y + 19 <= 35;
		expect(insideHole).toBe(false);
	});

	it('respects kerf spacing inside holes', () => {
		// 30x30 hole with kerf=2, inset to ~26x26. Place two 12x12 parts — both fit.
		// Then try a 14x14 — should NOT fit alongside a 12x12 in the 26x26 space.
		const ring = makePartWithHole('ring', 60, 60, 15, 15, 30, 30);
		const first = makePart('first', 12, 12);
		const second = makePart('second', 14, 14);
		const result = bottomLeftFill(
			[{ part: ring, rotation: 0 }, { part: first, rotation: 0 }, { part: second, rotation: 0 }],
			sheet, 2
		);
		expect(result).toHaveLength(3);
		// First should be inside the hole
		const fp = result[1];
		expect(fp.x).toBeGreaterThanOrEqual(15);
		expect(fp.y).toBeGreaterThanOrEqual(15);
		// Second should be on the sheet (kerf collision with first inside hole)
		const sp = result[2];
		const secondInsideHole = sp.x >= 15 && sp.y >= 15 && sp.x + 14 <= 45 && sp.y + 14 <= 45;
		expect(secondInsideHole).toBe(false);
	});

	it('places multiple small parts inside a single hole', () => {
		const frame = makePartWithHole('frame', 60, 60, 5, 5, 50, 50);
		const tiles = Array.from({ length: 4 }, (_, i) =>
			({ part: makePart(`tile${i}`, 15, 15), rotation: 0 })
		);
		const result = bottomLeftFill(
			[{ part: frame, rotation: 0 }, ...tiles],
			sheet
		);
		const tilesInHole = result.filter(pp =>
			pp.part.id.startsWith('tile') &&
			pp.x >= 5 && pp.y >= 5 &&
			pp.x + 15 <= 55 && pp.y + 15 <= 55
		);
		expect(tilesInHole.length).toBeGreaterThanOrEqual(2);
	});

	it('does not nest parts inside holes of hole-placed parts (no recursive nesting)', () => {
		const frame = makePartWithHole('frame', 60, 60, 10, 10, 40, 40);
		const medium = makePartWithHole('medium', 30, 30, 5, 5, 20, 20);
		const tiny = makePart('tiny', 5, 5);

		const result = bottomLeftFill(
			[{ part: frame, rotation: 0 }, { part: medium, rotation: 0 }, { part: tiny, rotation: 0 }],
			sheet
		);
		expect(result).toHaveLength(3);

		const mediumPlaced = result.find(pp => pp.part.id === 'medium')!;
		const tinyPlaced = result.find(pp => pp.part.id === 'tiny')!;

		// Medium should be fully inside frame's hole (10,10)-(50,50)
		expect(mediumPlaced.x).toBeGreaterThanOrEqual(10);
		expect(mediumPlaced.y).toBeGreaterThanOrEqual(10);
		expect(mediumPlaced.x + 30).toBeLessThanOrEqual(50);
		expect(mediumPlaced.y + 30).toBeLessThanOrEqual(50);

		// Tiny should NOT be inside medium's hole (no recursive nesting)
		const mhx = mediumPlaced.x + 5;
		const mhy = mediumPlaced.y + 5;
		const tinyInsideMediumHole = tinyPlaced.x >= mhx && tinyPlaced.y >= mhy &&
			tinyPlaced.x + 5 <= mhx + 20 && tinyPlaced.y + 5 <= mhy + 20;
		expect(tinyInsideMediumHole).toBe(false);

		// Tiny should be placed somewhere valid (on sheet or in frame's remaining hole space)
		expect(tinyPlaced.x).toBeGreaterThanOrEqual(0);
		expect(tinyPlaced.y).toBeGreaterThanOrEqual(0);
	});

	it('parts without holes nest as before', () => {
		const parts = [
			{ part: makePart('a', 20, 20), rotation: 0 },
			{ part: makePart('b', 20, 20), rotation: 0 }
		];
		const result = bottomLeftFill(parts, sheet);
		expect(result).toHaveLength(2);
		expect(result[0].x).toBeCloseTo(0);
		expect(result[0].y).toBeCloseTo(0);
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
