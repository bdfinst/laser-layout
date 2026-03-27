import { describe, it, expect } from 'vitest';
import { parseLightBurn } from './lightburn-parser';
import { deduplicateParts } from '$lib/geometry/dedup';

describe('parseLightBurn', () => {
	it('parses a simple Rect shape', () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
		<LightBurnProject AppVersion="1.0" FormatVersion="1">
			<Shape Type="Rect" CutIndex="0" W="100" H="50" Cr="0">
				<XForm>1 0 0 1 50 25</XForm>
			</Shape>
		</LightBurnProject>`;
		const parts = parseLightBurn(xml);
		expect(parts).toHaveLength(1);
		expect(parts[0].name).toBe('Rect-0');
		const poly = parts[0].polygons[0];
		expect(poly).toHaveLength(4);
		expect(poly[0]).toEqual({ x: 0, y: 0 });
		expect(poly[1]).toEqual({ x: 100, y: 0 });
	});

	it('parses an Ellipse shape', () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
		<LightBurnProject AppVersion="1.0" FormatVersion="1">
			<Shape Type="Ellipse" CutIndex="0" Rx="40" Ry="20">
				<XForm>1 0 0 1 100 50</XForm>
			</Shape>
		</LightBurnProject>`;
		const parts = parseLightBurn(xml);
		expect(parts).toHaveLength(1);
		expect(parts[0].polygons[0].length).toBeGreaterThanOrEqual(32);
	});

	it('parses a Path shape with VertList and PrimList (bezier)', () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
		<LightBurnProject AppVersion="1.0" FormatVersion="1">
			<Shape Type="Path" CutIndex="0" VertID="0" PrimID="0">
				<XForm>1 0 0 1 0 0</XForm>
				<VertList>V0 0c0x5c0y0c1x0c1y0V10 0c0x10c0y5c1x5c1y0V10 10c0x5c0y10c1x10c1y5V0 10c0x0c0y5c1x5c1y10</VertList>
				<PrimList>B0 1B1 2B2 3B3 0</PrimList>
			</Shape>
		</LightBurnProject>`;
		const parts = parseLightBurn(xml);
		expect(parts).toHaveLength(1);
		expect(parts[0].polygons[0].length).toBeGreaterThan(4);
	});

	it('parses a Path shape with line primitives', () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
		<LightBurnProject AppVersion="1.0" FormatVersion="1">
			<Shape Type="Path" CutIndex="0" VertID="0" PrimID="0">
				<XForm>1 0 0 1 0 0</XForm>
				<VertList>V0 0V10 0V10 10V0 10</VertList>
				<PrimList>L0 1L1 2L2 3L3 0</PrimList>
			</Shape>
		</LightBurnProject>`;
		const parts = parseLightBurn(xml);
		expect(parts).toHaveLength(1);
		expect(parts[0].polygons[0]).toEqual([
			{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }
		]);
	});

	it('applies XForm transform', () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
		<LightBurnProject AppVersion="1.0" FormatVersion="1">
			<Shape Type="Path" CutIndex="0" VertID="0" PrimID="0">
				<XForm>1 0 0 1 100 200</XForm>
				<VertList>V0 0V10 0V10 10V0 10</VertList>
				<PrimList>L0 1L1 2L2 3L3 0</PrimList>
			</Shape>
		</LightBurnProject>`;
		const parts = parseLightBurn(xml);
		expect(parts[0].polygons[0][0]).toEqual({ x: 100, y: 200 });
	});

	it('parses Group shapes with children', () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
		<LightBurnProject AppVersion="1.0" FormatVersion="1">
			<Shape Type="Group" CutIndex="0">
				<XForm>1 0 0 1 10 20</XForm>
				<Children>
					<Shape Type="Path" CutIndex="0" VertID="0" PrimID="0">
						<XForm>1 0 0 1 0 0</XForm>
						<VertList>V0 0V5 0V5 5V0 5</VertList>
						<PrimList>L0 1L1 2L2 3L3 0</PrimList>
					</Shape>
				</Children>
			</Shape>
		</LightBurnProject>`;
		const parts = parseLightBurn(xml);
		expect(parts).toHaveLength(1);
		expect(parts[0].polygons[0][0]).toEqual({ x: 10, y: 20 });
	});

	it('resolves shared VertID/PrimID from geometry pool', () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
		<LightBurnProject AppVersion="1.0" FormatVersion="1">
			<Shape Type="Path" CutIndex="0" VertID="5" PrimID="3">
				<XForm>1 0 0 1 0 0</XForm>
				<VertList>V0 0V10 0V10 10V0 10</VertList>
				<PrimList>L0 1L1 2L2 3L3 0</PrimList>
			</Shape>
			<Shape Type="Path" CutIndex="0" VertID="5" PrimID="3">
				<XForm>1 0 0 1 50 50</XForm>
			</Shape>
		</LightBurnProject>`;
		const parts = parseLightBurn(xml);
		expect(parts).toHaveLength(2);
		// First part at origin
		expect(parts[0].polygons[0][0]).toEqual({ x: 0, y: 0 });
		// Second part uses shared pool, placed at (50,50)
		expect(parts[1].polygons[0][0]).toEqual({ x: 50, y: 50 });
		expect(parts[1].polygons[0]).toHaveLength(4);
	});

	it('parses the Hot Air Balloon fixture and produces correct part count', async () => {
		const fs = await import('fs');
		const path = await import('path');
		const fixturePath = path.resolve('test-fixtures/Hot Air Balloon.lbrn2');
		const xml = fs.readFileSync(fixturePath, 'utf-8');
		const parts = parseLightBurn(xml);

		// Should have more than 10 parts (file has ~15 shapes across groups)
		expect(parts.length).toBeGreaterThanOrEqual(10);

		// Every part should have valid polygons
		for (const part of parts) {
			expect(part.polygons.length).toBeGreaterThan(0);
			for (const poly of part.polygons) {
				expect(poly.length).toBeGreaterThanOrEqual(3);
			}
		}
	});

	it('detects duplicate shapes in Hot Air Balloon fixture', async () => {
		const fs = await import('fs');
		const path = await import('path');
		const fixturePath = path.resolve('test-fixtures/Hot Air Balloon.lbrn2');
		const xml = fs.readFileSync(fixturePath, 'utf-8');
		const parts = parseLightBurn(xml);
		const { uniqueParts, quantities } = deduplicateParts(parts);

		// Should have fewer unique parts than total parts
		expect(uniqueParts.length).toBeLessThan(parts.length);

		// Total quantities should equal total parsed parts
		let totalQty = 0;
		for (const qty of quantities.values()) totalQty += qty;
		expect(totalQty).toBe(parts.length);

		// At least one part should have quantity > 1
		const maxQty = Math.max(...quantities.values());
		expect(maxQty).toBeGreaterThan(1);
	});
});
