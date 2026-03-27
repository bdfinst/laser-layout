import { describe, it, expect } from 'vitest';
import { parseSVG } from '$lib/parsers/svg-parser';

describe('parseSVG', () => {
	it('parses a rect element', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
			<rect x="10" y="20" width="30" height="40"/>
		</svg>`;
		const parts = parseSVG(svg);
		expect(parts).toHaveLength(1);
		expect(parts[0].polygons[0]).toHaveLength(4);
		const poly = parts[0].polygons[0];
		expect(poly[0]).toEqual({ x: 10, y: 20 });
		expect(poly[1]).toEqual({ x: 40, y: 20 });
		expect(poly[2]).toEqual({ x: 40, y: 60 });
		expect(poly[3]).toEqual({ x: 10, y: 60 });
	});

	it('parses a circle element', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg">
			<circle cx="50" cy="50" r="25"/>
		</svg>`;
		const parts = parseSVG(svg);
		expect(parts).toHaveLength(1);
		// Circle approximated as polygon with many points
		expect(parts[0].polygons[0].length).toBeGreaterThanOrEqual(32);
		// All points should be roughly 25 units from center
		for (const p of parts[0].polygons[0]) {
			const dist = Math.sqrt((p.x - 50) ** 2 + (p.y - 50) ** 2);
			expect(dist).toBeCloseTo(25, 0);
		}
	});

	it('parses an ellipse element', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg">
			<ellipse cx="100" cy="50" rx="40" ry="20"/>
		</svg>`;
		const parts = parseSVG(svg);
		expect(parts).toHaveLength(1);
		expect(parts[0].polygons[0].length).toBeGreaterThanOrEqual(32);
	});

	it('parses a polygon element', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg">
			<polygon points="10,10 40,10 25,40"/>
		</svg>`;
		const parts = parseSVG(svg);
		expect(parts).toHaveLength(1);
		expect(parts[0].polygons[0]).toEqual([
			{ x: 10, y: 10 },
			{ x: 40, y: 10 },
			{ x: 25, y: 40 }
		]);
	});

	it('parses a polyline element', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg">
			<polyline points="0,0 50,0 50,50 0,50"/>
		</svg>`;
		const parts = parseSVG(svg);
		expect(parts).toHaveLength(1);
		expect(parts[0].polygons[0]).toHaveLength(4);
	});

	it('parses a path with M, L, Z commands', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg">
			<path d="M 0 0 L 100 0 L 100 50 L 0 50 Z"/>
		</svg>`;
		const parts = parseSVG(svg);
		expect(parts).toHaveLength(1);
		expect(parts[0].polygons[0]).toEqual([
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 100, y: 50 },
			{ x: 0, y: 50 }
		]);
	});

	it('parses a path with relative commands (m, l, z)', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg">
			<path d="m 10 10 l 20 0 l 0 20 l -20 0 z"/>
		</svg>`;
		const parts = parseSVG(svg);
		expect(parts).toHaveLength(1);
		const poly = parts[0].polygons[0];
		expect(poly[0]).toEqual({ x: 10, y: 10 });
		expect(poly[1]).toEqual({ x: 30, y: 10 });
		expect(poly[2]).toEqual({ x: 30, y: 30 });
		expect(poly[3]).toEqual({ x: 10, y: 30 });
	});

	it('parses a path with cubic bezier (C)', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg">
			<path d="M 0 0 C 10 20 30 20 40 0"/>
		</svg>`;
		const parts = parseSVG(svg);
		expect(parts).toHaveLength(1);
		// Should have start + approximated curve points
		expect(parts[0].polygons[0].length).toBeGreaterThan(2);
	});

	it('parses a path with H and V commands', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg">
			<path d="M 0 0 H 50 V 30 H 0 Z"/>
		</svg>`;
		const parts = parseSVG(svg);
		expect(parts).toHaveLength(1);
		expect(parts[0].polygons[0]).toEqual([
			{ x: 0, y: 0 },
			{ x: 50, y: 0 },
			{ x: 50, y: 30 },
			{ x: 0, y: 30 }
		]);
	});

	it('parses multiple shapes into separate parts', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg">
			<rect x="0" y="0" width="10" height="10"/>
			<circle cx="50" cy="50" r="5"/>
		</svg>`;
		const parts = parseSVG(svg);
		expect(parts).toHaveLength(2);
	});

	it('assigns unique IDs and names', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg">
			<rect id="myRect" x="0" y="0" width="10" height="10"/>
			<circle cx="50" cy="50" r="5"/>
		</svg>`;
		const parts = parseSVG(svg);
		expect(parts[0].name).toBe('myRect');
		expect(parts[1].name).toBe('circle-1');
	});

	it('applies transform on elements', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg">
			<rect x="0" y="0" width="10" height="10" transform="translate(100, 200)"/>
		</svg>`;
		const parts = parseSVG(svg);
		const poly = parts[0].polygons[0];
		expect(poly[0]).toEqual({ x: 100, y: 200 });
		expect(poly[2]).toEqual({ x: 110, y: 210 });
	});

	it('handles nested groups with transforms', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg">
			<g transform="translate(10, 20)">
				<rect x="0" y="0" width="5" height="5"/>
			</g>
		</svg>`;
		const parts = parseSVG(svg);
		const poly = parts[0].polygons[0];
		expect(poly[0]).toEqual({ x: 10, y: 20 });
		expect(poly[2]).toEqual({ x: 15, y: 25 });
	});

	it('handles scale transform', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg">
			<rect x="0" y="0" width="10" height="10" transform="scale(2)"/>
		</svg>`;
		const parts = parseSVG(svg);
		expect(parts[0].polygons[0][1]).toEqual({ x: 20, y: 0 });
	});

	it('handles matrix transform', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg">
			<rect x="0" y="0" width="10" height="10" transform="matrix(1 0 0 1 10 20)"/>
		</svg>`;
		const parts = parseSVG(svg);
		expect(parts[0].polygons[0][0]).toEqual({ x: 10, y: 20 });
	});

	it('parses quadratic bezier path (Q)', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg">
			<path d="M 0 0 Q 10 20 20 0"/>
		</svg>`;
		const parts = parseSVG(svg);
		expect(parts[0].polygons[0].length).toBeGreaterThan(2);
	});

	it('parses multi-subpath (multiple M commands)', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg">
			<path d="M 0 0 L 10 0 L 10 10 Z M 20 20 L 30 20 L 30 30 Z"/>
		</svg>`;
		const parts = parseSVG(svg);
		expect(parts[0].polygons).toHaveLength(2);
	});

	it('parses smooth cubic bezier path (S)', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg">
			<path d="M 0 0 C 5 10 15 10 20 0 S 35 -10 40 0"/>
		</svg>`;
		const parts = parseSVG(svg);
		expect(parts[0].polygons[0].length).toBeGreaterThan(2);
	});

	it('parses smooth quadratic bezier path (T)', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg">
			<path d="M 0 0 Q 10 20 20 0 T 40 0"/>
		</svg>`;
		const parts = parseSVG(svg);
		expect(parts[0].polygons[0].length).toBeGreaterThan(2);
	});

	it('parses relative h and v commands', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg">
			<path d="M 0 0 h 50 v 30 h -50 z"/>
		</svg>`;
		const parts = parseSVG(svg);
		expect(parts[0].polygons[0]).toEqual([
			{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 30 }, { x: 0, y: 30 }
		]);
	});

	it('returns empty for SVG with no shapes', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>`;
		expect(parseSVG(svg)).toHaveLength(0);
	});

	it('returns empty for empty SVG', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg"></svg>`;
		expect(parseSVG(svg)).toHaveLength(0);
	});

	it('ignores non-shape elements like script', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg">
			<script>alert(1)</script>
			<rect x="0" y="0" width="10" height="10"/>
		</svg>`;
		const parts = parseSVG(svg);
		// Only the rect is extracted — script is structurally ignored by processElement
		expect(parts).toHaveLength(1);
	});
});
