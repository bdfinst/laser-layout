import { describe, it, expect } from 'vitest';
import { exportToSVG } from './svg-exporter';
import type { Part, PlacedPart } from '$lib/geometry/types';

function makePlaced(id: string, w: number, h: number, x: number, y: number, rotation = 0): PlacedPart {
	const part: Part = {
		id, name: id,
		polygons: [[{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]],
		sourceIndex: 0
	};
	return { part, x, y, rotation };
}

describe('exportToSVG', () => {
	it('generates valid SVG with xml declaration', () => {
		const svg = exportToSVG([], { sheetWidth: 100, sheetHeight: 50 });
		expect(svg).toContain('<?xml'); expect(svg).toContain('<svg'); expect(svg).toContain('</svg>');
	});

	it('includes sheet dimensions in viewBox', () => {
		const svg = exportToSVG([], { sheetWidth: 200, sheetHeight: 150 });
		expect(svg).toContain('viewBox="0 0 200 150"');
	});

	it('includes sheet outline when showSheet is true', () => {
		expect(exportToSVG([], { sheetWidth: 100, sheetHeight: 100, showSheet: true })).toContain('<rect');
	});

	it('excludes sheet outline when showSheet is false', () => {
		expect(exportToSVG([], { sheetWidth: 100, sheetHeight: 100, showSheet: false })).not.toContain('<rect');
	});

	it('renders placed parts as paths', () => {
		const svg = exportToSVG([makePlaced('a', 10, 10, 5, 5)], { sheetWidth: 100, sheetHeight: 100 });
		expect(svg).toContain('<path'); expect(svg).toContain('d="M');
	});

	it('renders multiple parts', () => {
		const svg = exportToSVG([makePlaced('a', 10, 10, 0, 0), makePlaced('b', 20, 15, 15, 0)], { sheetWidth: 100, sheetHeight: 100 });
		expect((svg.match(/<path/g) ?? []).length).toBe(2);
	});

	it('uses custom stroke color and width', () => {
		const svg = exportToSVG([makePlaced('a', 10, 10, 0, 0)], {
			sheetWidth: 100, sheetHeight: 100, strokeColor: '#ff0000', strokeWidth: 1.5
		});
		expect(svg).toContain('stroke="#ff0000"'); expect(svg).toContain('stroke-width="1.5"');
	});

	it('sanitizes invalid stroke color', () => {
		const svg = exportToSVG([makePlaced('a', 10, 10, 0, 0)], {
			sheetWidth: 100, sheetHeight: 100, strokeColor: '" onload="alert(1)'
		});
		expect(svg).toContain('stroke="#000000"');
		expect(svg).not.toContain('onload');
	});

	it('renders rotated parts with different coordinates than unrotated', () => {
		const rotated = exportToSVG([makePlaced('a', 10, 20, 0, 0, Math.PI / 2)], { sheetWidth: 100, sheetHeight: 100 });
		const unrotated = exportToSVG([makePlaced('a', 10, 20, 0, 0, 0)], { sheetWidth: 100, sheetHeight: 100 });
		// Extract path d attributes
		const getD = (svg: string) => svg.match(/d="([^"]+)"/)?.[1] ?? '';
		expect(getD(rotated)).not.toBe(getD(unrotated));
	});

	it('renders parts with multiple polygons', () => {
		const part: Part = { id: 'a', name: 'a', polygons: [
			[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
			[{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }]
		], sourceIndex: 0 };
		const svg = exportToSVG([{ part, x: 0, y: 0, rotation: 0 }], { sheetWidth: 100, sheetHeight: 100 });
		expect((svg.match(/<path/g) ?? []).length).toBe(2);
	});
});
