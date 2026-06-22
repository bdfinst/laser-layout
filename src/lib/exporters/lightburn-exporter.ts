import type { PlacedPart, Polygon } from '$lib/geometry/types';
import { getPlacedPolygons } from '$lib/geometry/polygon';
import { escapeXml } from './xml-utils';

export interface LightBurnExportOptions {
  sheetWidth: number;
  sheetHeight: number;
  appVersion?: string;
}

const VERSION_RE = /^[\d.]+$/;

// LightBurn tool layers (T1/T2) are non-output guide layers. The material/sheet
// rectangle uses T1 (CutIndex 30) so it is shown as a boundary but never cut.
const TOOL_LAYER_INDEX = 30;

export function exportToLightBurn(placed: PlacedPart[], options: LightBurnExportOptions): string {
  const { sheetWidth, sheetHeight, appVersion = '1.0' } = options;
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

  for (const pp of placed) {
    const polygons = getPlacedPolygons(pp);
    for (const poly of polygons) {
      writePathShape(lines, poly);
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

function formatNum(n: number): string {
  return n.toFixed(4);
}
