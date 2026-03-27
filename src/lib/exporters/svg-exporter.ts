import type { PlacedPart } from '$lib/geometry/types';
import { getPlacedPolygons, toSVGPathD } from '$lib/geometry/polygon';
import { escapeXml } from './xml-utils';

export interface SVGExportOptions {
	sheetWidth: number;
	sheetHeight: number;
	strokeColor?: string;
	strokeWidth?: number;
	showSheet?: boolean;
}

const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

export function exportToSVG(
	placed: PlacedPart[],
	options: SVGExportOptions
): string {
	const {
		sheetWidth, sheetHeight,
		strokeColor = '#000000',
		strokeWidth = 0.5,
		showSheet = true
	} = options;

	const safeColor = COLOR_RE.test(strokeColor) ? strokeColor : '#000000';

	const lines: string[] = [];
	lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
	lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${sheetWidth}mm" height="${sheetHeight}mm" viewBox="0 0 ${sheetWidth} ${sheetHeight}">`);

	if (showSheet) {
		lines.push(`  <rect x="0" y="0" width="${sheetWidth}" height="${sheetHeight}" fill="none" stroke="#cccccc" stroke-width="0.5" stroke-dasharray="2,2"/>`);
	}

	for (const pp of placed) {
		const polygons = getPlacedPolygons(pp);
		for (const poly of polygons) {
			const d = toSVGPathD(poly, 3);
			lines.push(`  <path d="${escapeXml(d)}" fill="none" stroke="${safeColor}" stroke-width="${strokeWidth}"/>`);
		}
	}

	lines.push('</svg>');
	return lines.join('\n');
}
