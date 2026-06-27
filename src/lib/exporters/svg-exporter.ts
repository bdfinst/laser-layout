import type { PlacedPart, SheetResult } from '$lib/geometry/types';
import { getPlacedPolygons, toSVGPathD } from '$lib/geometry/polygon';
import { escapeXml } from './xml-utils';
import { dedupeCommonLineEdges } from './common-line';
import { sheetExportFilename, type SheetExportFile } from './sheet-export';

export interface SVGExportOptions {
  sheetWidth: number;
  sheetHeight: number;
  strokeColor?: string;
  strokeWidth?: number;
  showSheet?: boolean;
  /** Common-line cutting (#43): emit each shared edge once instead of per part. */
  commonLineCutting?: boolean;
}

const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

export function exportToSVG(placed: PlacedPart[], options: SVGExportOptions): string {
  const {
    sheetWidth,
    sheetHeight,
    strokeColor = '#000000',
    strokeWidth = 0.5,
    showSheet = true,
    commonLineCutting = false,
  } = options;

  const safeColor = COLOR_RE.test(strokeColor) ? strokeColor : '#000000';

  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetWidth}mm" height="${sheetHeight}mm" viewBox="0 0 ${sheetWidth} ${sheetHeight}">`,
  );

  if (showSheet) {
    lines.push(
      `  <rect x="0" y="0" width="${sheetWidth}" height="${sheetHeight}" fill="none" stroke="#cccccc" stroke-width="0.5" stroke-dasharray="2,2"/>`,
    );
  }

  if (commonLineCutting) {
    // Each unique cut edge once; shared boundaries between abutting parts collapse to a
    // single line so they aren't cut twice.
    for (const [a, b] of dedupeCommonLineEdges(placed)) {
      const d = `M ${a.x.toFixed(3)} ${a.y.toFixed(3)} L ${b.x.toFixed(3)} ${b.y.toFixed(3)}`;
      lines.push(
        `  <path d="${escapeXml(d)}" fill="none" stroke="${safeColor}" stroke-width="${strokeWidth}"/>`,
      );
    }
  } else {
    for (const pp of placed) {
      const polygons = getPlacedPolygons(pp);
      for (const poly of polygons) {
        const d = toSVGPathD(poly, 3);
        lines.push(
          `  <path d="${escapeXml(d)}" fill="none" stroke="${safeColor}" stroke-width="${strokeWidth}"/>`,
        );
      }
    }
  }

  lines.push('</svg>');
  return lines.join('\n');
}

/** Options shared across every sheet of a multi-sheet SVG export (no per-sheet size). */
export type SheetSVGExportOptions = Omit<SVGExportOptions, 'sheetWidth' | 'sheetHeight'>;

/**
 * Export every sheet of a nesting result to its own SVG, each sized by that sheet's own
 * dimensions (#26). Returns one {@link SheetExportFile} per sheet.
 */
export function exportSheetsToSVG(
  result: { sheets: SheetResult[] },
  options: SheetSVGExportOptions = {},
): SheetExportFile[] {
  return result.sheets.map((sheet) => ({
    filename: sheetExportFilename(sheet.sheetIndex, result.sheets.length, 'svg'),
    content: exportToSVG(sheet.placed, {
      ...options,
      sheetWidth: sheet.sheetWidth,
      sheetHeight: sheet.sheetHeight,
    }),
  }));
}
