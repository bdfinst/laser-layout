import { describe, it, expect } from 'vitest';
import { deduplicateParts } from '$lib/geometry/dedup';
import type { Part } from '$lib/geometry/types';

function makePart(id: string, w: number, h: number, x = 0, y = 0): Part {
	return {
		id, name: id,
		polygons: [[
			{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }
		]],
		sourceIndex: 0
	};
}

describe('deduplicateParts', () => {
	it('returns empty for empty input', () => {
		const { uniqueParts, quantities } = deduplicateParts([]);
		expect(uniqueParts).toHaveLength(0);
		expect(quantities.size).toBe(0);
	});

	it('returns single part as-is with quantity 1', () => {
		const { uniqueParts, quantities } = deduplicateParts([makePart('a', 10, 10)]);
		expect(uniqueParts).toHaveLength(1);
		expect(quantities.get(uniqueParts[0].id)).toBe(1);
	});

	it('merges identical parts at different positions', () => {
		const parts = [
			makePart('a', 10, 10, 0, 0),
			makePart('b', 10, 10, 50, 50),
			makePart('c', 10, 10, 100, 100)
		];
		const { uniqueParts, quantities } = deduplicateParts(parts);
		expect(uniqueParts).toHaveLength(1);
		expect(quantities.get(uniqueParts[0].id)).toBe(3);
	});

	it('keeps geometrically distinct parts separate', () => {
		const parts = [
			makePart('a', 10, 10),
			makePart('b', 20, 30)
		];
		const { uniqueParts, quantities } = deduplicateParts(parts);
		expect(uniqueParts).toHaveLength(2);
		expect(quantities.get(uniqueParts[0].id)).toBe(1);
		expect(quantities.get(uniqueParts[1].id)).toBe(1);
	});

	it('total quantities equal input count', () => {
		const parts = [
			makePart('a', 10, 10, 0, 0),
			makePart('b', 10, 10, 50, 0),
			makePart('c', 20, 30, 0, 50),
			makePart('d', 20, 30, 100, 100)
		];
		const { uniqueParts, quantities } = deduplicateParts(parts);
		let total = 0;
		for (const qty of quantities.values()) total += qty;
		expect(total).toBe(4);
		expect(uniqueParts).toHaveLength(2);
	});

	it('matches within default 1% tolerance', () => {
		// 10mm wide vs 10.08mm wide = 0.8% difference
		const parts = [
			makePart('a', 10, 10),
			makePart('b', 10.08, 10)
		];
		const { uniqueParts } = deduplicateParts(parts, 0.01);
		expect(uniqueParts).toHaveLength(1);
	});

	it('does not match beyond tolerance', () => {
		// 10mm wide vs 10.5mm wide = 5% difference
		const parts = [
			makePart('a', 10, 10),
			makePart('b', 10.5, 10)
		];
		const { uniqueParts } = deduplicateParts(parts, 0.01);
		expect(uniqueParts).toHaveLength(2);
	});

	it('tighter tolerance splits near-duplicates', () => {
		const parts = [
			makePart('a', 10, 10),
			makePart('b', 10.08, 10) // 0.8% diff
		];
		// At 1% tolerance: matches
		expect(deduplicateParts(parts, 0.01).uniqueParts).toHaveLength(1);
		// At 0.1% tolerance: too different
		expect(deduplicateParts(parts, 0.001).uniqueParts).toHaveLength(2);
	});

	it('does not match parts with different polygon counts', () => {
		const a: Part = { id: 'a', name: 'a', polygons: [
			[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]
		], sourceIndex: 0 };
		const b: Part = { id: 'b', name: 'b', polygons: [
			[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
			[{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }]
		], sourceIndex: 1 };
		const { uniqueParts } = deduplicateParts([a, b]);
		expect(uniqueParts).toHaveLength(2);
	});
});
