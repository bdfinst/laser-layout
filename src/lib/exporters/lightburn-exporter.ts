import type { PlacedPart, Point, Polygon, SheetResult } from '$lib/geometry/types';
import { getPlacedPolygons } from '$lib/geometry/polygon';
import { escapeXml } from './xml-utils';
import { dedupeCommonLineEdges, COMMON_LINE_TOLERANCE } from './common-line';
import { sheetExportFilename, type SheetExportFile } from './sheet-export';

export interface LightBurnExportOptions {
  sheetWidth: number;
  sheetHeight: number;
  appVersion?: string;
  /** Common-line cutting (#43): emit each shared edge once instead of per part. */
  commonLineCutting?: boolean;
}

const VERSION_RE = /^[\d.]+$/;

// LightBurn tool layers (T1/T2) are non-output guide layers. The material/sheet
// rectangle uses T1 (CutIndex 30) so it is shown as a boundary but never cut.
const TOOL_LAYER_INDEX = 30;

export function exportToLightBurn(placed: PlacedPart[], options: LightBurnExportOptions): string {
  const { sheetWidth, sheetHeight, appVersion = '1.0', commonLineCutting = false } = options;
  const safeVersion = VERSION_RE.test(appVersion) ? appVersion : '1.0';

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<LightBurnProject AppVersion="${escapeXml(safeVersion)}" FormatVersion="1" MaterialHeight="0" MirrorX="False" MirrorY="False">`,
  );

  lines.push('    <CutSetting type="Cut">');
  lines.push('        <index Value="0"/>');
  lines.push('        <name Value="Cut"/>');
  lines.push('        <priority Value="0"/>');
  lines.push('    </CutSetting>');

  lines.push('    <CutSetting type="Tool">');
  lines.push(`        <index Value="${TOOL_LAYER_INDEX}"/>`);
  lines.push('        <name Value="Sheet"/>');
  lines.push('        <priority Value="1"/>');
  lines.push('    </CutSetting>');

  if (commonLineCutting) {
    writeCommonLineShape(lines, dedupeCommonLineEdges(placed));
  } else {
    for (const pp of placed) {
      const polygons = getPlacedPolygons(pp);
      for (const poly of polygons) {
        writePathShape(lines, poly);
      }
    }
  }

  lines.push(
    `    <Shape Type="Rect" CutIndex="${TOOL_LAYER_INDEX}" W="${sheetWidth}" H="${sheetHeight}" Cr="0">`,
  );
  lines.push(`        <XForm>1 0 0 1 ${sheetWidth / 2} ${sheetHeight / 2}</XForm>`);
  lines.push('    </Shape>');

  lines.push('    <Notes ShowOnLoad="0" Notes=""/>');
  lines.push('</LightBurnProject>');

  return lines.join('\n');
}

/** Options shared across every sheet of a multi-sheet LightBurn export (no per-sheet size). */
export type SheetLightBurnExportOptions = Omit<
  LightBurnExportOptions,
  'sheetWidth' | 'sheetHeight'
>;

/**
 * Export every sheet of a nesting result to its own LightBurn project, each sized by that sheet's
 * own dimensions (#26). Returns one {@link SheetExportFile} per sheet.
 */
export function exportSheetsToLightBurn(
  result: { sheets: SheetResult[] },
  options: SheetLightBurnExportOptions = {},
): SheetExportFile[] {
  return result.sheets.map((sheet) => ({
    filename: sheetExportFilename(sheet.sheetIndex, result.sheets.length, 'lbrn2'),
    content: exportToLightBurn(sheet.placed, {
      ...options,
      sheetWidth: sheet.sheetWidth,
      sheetHeight: sheet.sheetHeight,
    }),
  }));
}

function writePathShape(lines: string[], polygon: Polygon): void {
  if (polygon.length < 3) return;

  lines.push('    <Shape Type="Path" CutIndex="0">');
  lines.push('        <XForm>1 0 0 1 0 0</XForm>');

  const vertParts: string[] = [];
  for (const p of polygon) {
    vertParts.push(`V${formatNum(p.x)} ${formatNum(p.y)}`);
  }
  lines.push(`        <VertList>${vertParts.join('')}</VertList>`);

  const primParts: string[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const next = (i + 1) % polygon.length;
    primParts.push(`L${i} ${next}`);
  }
  lines.push(`        <PrimList>${primParts.join('')}</PrimList>`);

  lines.push('    </Shape>');
}

/**
 * Emit the deduped common-line edges (#43) as a single open Path shape: a shared vertex
 * list plus one line primitive per unique edge. Shared boundaries between abutting parts
 * appear once, so the laser cuts each common line a single time.
 */
function writeCommonLineShape(lines: string[], segments: [Point, Point][]): void {
  if (segments.length === 0) return;

  const q = COMMON_LINE_TOLERANCE > 0 ? 1 / COMMON_LINE_TOLERANCE : 1e6;
  const indexOf = new Map<string, number>();
  const verts: Point[] = [];
  const prims: Array<[number, number]> = [];

  const vertIndex = (p: Point): number => {
    const key = `${Math.round(p.x * q)},${Math.round(p.y * q)}`;
    let idx = indexOf.get(key);
    if (idx === undefined) {
      idx = verts.length;
      indexOf.set(key, idx);
      verts.push(p);
    }
    return idx;
  };

  for (const [a, b] of segments) prims.push([vertIndex(a), vertIndex(b)]);

  lines.push('    <Shape Type="Path" CutIndex="0">');
  lines.push('        <XForm>1 0 0 1 0 0</XForm>');
  lines.push(
    `        <VertList>${verts.map((p) => `V${formatNum(p.x)} ${formatNum(p.y)}`).join('')}</VertList>`,
  );
  lines.push(`        <PrimList>${prims.map(([i, j]) => `L${i} ${j}`).join('')}</PrimList>`);
  lines.push('    </Shape>');
}

function formatNum(n: number): string {
  return n.toFixed(4);
}
