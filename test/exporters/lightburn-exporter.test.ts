import { describe, it, expect } from 'vitest';
import { exportToLightBurn } from '$lib/exporters/lightburn-exporter';
import type { Part, PlacedPart } from '$lib/geometry/types';

function makePlaced(id: string, w: number, h: number, x: number, y: number, rotation = 0): PlacedPart {
	const part: Part = {
		id, name: id,
		polygons: [[{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]],
		sourceIndex: 0
	};
	return { part, x, y, rotation };
}

describe('exportToLightBurn', () => {
	it('generates valid XML', () => {
		const xml = exportToLightBurn([], { sheetWidth: 100, sheetHeight: 100 });
		expect(xml).toContain('<?xml'); expect(xml).toContain('<LightBurnProject'); expect(xml).toContain('</LightBurnProject>');
	});

	it('includes CutSetting', () => {
		expect(exportToLightBurn([], { sheetWidth: 100, sheetHeight: 100 })).toContain('<CutSetting');
	});

	it('includes sheet boundary rect', () => {
		const xml = exportToLightBurn([], { sheetWidth: 200, sheetHeight: 150 });
		expect(xml).toContain('W="200"'); expect(xml).toContain('H="150"');
	});

	it('renders placed parts as Path shapes', () => {
		const xml = exportToLightBurn([makePlaced('a', 10, 10, 0, 0)], { sheetWidth: 100, sheetHeight: 100 });
		expect(xml).toContain('Type="Path"'); expect(xml).toContain('<VertList>'); expect(xml).toContain('<PrimList>');
	});

	it('includes vertex coordinates', () => {
		const xml = exportToLightBurn([makePlaced('a', 10, 10, 5, 5)], { sheetWidth: 100, sheetHeight: 100 });
		expect(xml).toContain('V5.0000 5.0000'); expect(xml).toContain('V15.0000 5.0000');
	});

	it('uses line primitives', () => {
		const xml = exportToLightBurn([makePlaced('a', 10, 10, 0, 0)], { sheetWidth: 100, sheetHeight: 100 });
		expect(xml).toContain('L0 1'); expect(xml).toContain('L3 0');
	});

	it('renders multiple parts', () => {
		const xml = exportToLightBurn([makePlaced('a', 10, 10, 0, 0), makePlaced('b', 20, 15, 15, 0)], { sheetWidth: 100, sheetHeight: 100 });
		expect((xml.match(/Type="Path"/g) ?? []).length).toBe(2);
	});

	it('is parseable as XML', () => {
		const xml = exportToLightBurn([makePlaced('a', 10, 10, 0, 0)], { sheetWidth: 100, sheetHeight: 100 });
		const doc = new DOMParser().parseFromString(xml, 'text/xml');
		expect(doc.querySelector('parsererror')).toBeNull();
	});

	it('sanitizes appVersion', () => {
		const xml = exportToLightBurn([], { sheetWidth: 100, sheetHeight: 100, appVersion: '"><evil' });
		expect(xml).toContain('AppVersion="1.0"');
		expect(xml).not.toContain('evil');
	});

	it('renders rotated parts with different vertices than unrotated', () => {
		const rotated = exportToLightBurn([makePlaced('a', 10, 20, 0, 0, Math.PI / 2)], { sheetWidth: 100, sheetHeight: 100 });
		const unrotated = exportToLightBurn([makePlaced('a', 10, 20, 0, 0, 0)], { sheetWidth: 100, sheetHeight: 100 });
		// Extract VertList content
		const getVerts = (xml: string) => xml.match(/<VertList>(.*?)<\/VertList>/)?.[1] ?? '';
		expect(getVerts(rotated)).not.toBe(getVerts(unrotated));
	});

	it('skips degenerate 2-point polygons', () => {
		const part: Part = { id: 'a', name: 'a', polygons: [[{ x: 0, y: 0 }, { x: 10, y: 0 }]], sourceIndex: 0 };
		const xml = exportToLightBurn([{ part, x: 0, y: 0, rotation: 0 }], { sheetWidth: 100, sheetHeight: 100 });
		expect(xml).not.toContain('Type="Path"');
	});
});
