import { describe, it, expect } from 'vitest';
import {
  parseLightBurn,
  parseLightBurnWithDiagnostics,
  summarizeSkipped,
} from '$lib/parsers/lightburn-parser';
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
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
  });

  it('parses a Path whose PrimList is the LineClosed shorthand', () => {
    // LightBurn writes 'LineClosed' instead of explicit L/B primitives for
    // simple closed polylines — connect every vertex in order, closed.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
		<LightBurnProject AppVersion="1.0" FormatVersion="1">
			<Shape Type="Path" CutIndex="0" VertID="0" PrimID="0">
				<XForm>1 0 0 1 0 0</XForm>
				<VertList>V0 0c0x1c1x1V10 0c0x1c1x1V10 10c0x1c1x1V0 10c0x1c1x1</VertList>
				<PrimList>LineClosed</PrimList>
			</Shape>
		</LightBurnProject>`;
    const parts = parseLightBurn(xml);
    expect(parts).toHaveLength(1);
    expect(parts[0].polygons[0]).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
  });

  it('resolves a shared LineClosed PrimList from the geometry pool', () => {
    // Many shapes share one PrimID="5" => 'LineClosed' while each carries its
    // own VertList. The pooled LineClosed must apply to each shape's own verts.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
		<LightBurnProject AppVersion="1.0" FormatVersion="1">
			<Shape Type="Path" CutIndex="0" VertID="1" PrimID="5">
				<XForm>1 0 0 1 0 0</XForm>
				<VertList>V0 0c0x1c1x1V4 0c0x1c1x1V4 4c0x1c1x1V0 4c0x1c1x1</VertList>
				<PrimList>LineClosed</PrimList>
			</Shape>
			<Shape Type="Path" CutIndex="0" VertID="2" PrimID="5">
				<XForm>1 0 0 1 0 0</XForm>
				<VertList>V20 20c0x1c1x1V26 20c0x1c1x1V26 26c0x1c1x1V20 26c0x1c1x1</VertList>
			</Shape>
		</LightBurnProject>`;
    const parts = parseLightBurn(xml);
    expect(parts).toHaveLength(2);
    expect(parts[1].polygons[0]).toEqual([
      { x: 20, y: 20 },
      { x: 26, y: 20 },
      { x: 26, y: 26 },
      { x: 20, y: 26 },
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

  it('parses every shape in the Lego shelves fixture (LineClosed cutouts)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const fixturePath = path.resolve('test-fixtures/lego-shelves.lbrn2');
    const xml = fs.readFileSync(fixturePath, 'utf-8');
    const parts = parseLightBurn(xml);

    // The file contains 54 Path shapes; none should be silently dropped.
    expect(parts.length).toBe(54);
    for (const part of parts) {
      expect(part.polygons.length).toBeGreaterThan(0);
      for (const poly of part.polygons) {
        expect(poly.length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('stitches separate open 2-point segments into one closed contour', () => {
    // A box-generator emits its outline as four disconnected 2-point line
    // segments. Each assembles to a 2-point polygon (< 3) and was dropped,
    // so the whole outline vanished. Endpoints are shared, so they must be
    // stitched into a single closed contour before the < 3 drop.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
		<LightBurnProject AppVersion="1.0" FormatVersion="1">
			<Shape Type="Path" CutIndex="0"><XForm>1 0 0 1 0 0</XForm><VertList>V0 0V10 0</VertList><PrimList>L0 1</PrimList></Shape>
			<Shape Type="Path" CutIndex="0"><XForm>1 0 0 1 0 0</XForm><VertList>V10 0V10 10</VertList><PrimList>L0 1</PrimList></Shape>
			<Shape Type="Path" CutIndex="0"><XForm>1 0 0 1 0 0</XForm><VertList>V10 10V0 10</VertList><PrimList>L0 1</PrimList></Shape>
			<Shape Type="Path" CutIndex="0"><XForm>1 0 0 1 0 0</XForm><VertList>V0 10V0 0</VertList><PrimList>L0 1</PrimList></Shape>
		</LightBurnProject>`;
    const parts = parseLightBurn(xml);
    expect(parts).toHaveLength(1);
    expect(parts[0].polygons[0]).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
  });

  it('imports shapes when layer filtering would otherwise exclude them all', () => {
    // The allowed cut-index set is built from Cut-type settings (here {1,2}),
    // but the only real geometry sits on CutIndex 5 — backed solely by a
    // type="Tool" setting, which is excluded from the allowed set. The filter
    // must fail open rather than drop every shape and yield an empty import.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
		<LightBurnProject AppVersion="1.0" FormatVersion="1">
			<CutSetting type="Cut"><index Value="1"/></CutSetting>
			<CutSetting type="Cut"><index Value="2"/></CutSetting>
			<CutSetting type="Tool"><index Value="5"/></CutSetting>
			<Shape Type="Rect" CutIndex="5" W="10" H="10"><XForm>1 0 0 1 0 0</XForm></Shape>
		</LightBurnProject>`;
    const parts = parseLightBurn(xml);
    expect(parts).toHaveLength(1);
  });

  it('still filters a layer when other shapes survive the filter', () => {
    // Filtering must remain effective when it does not zero the result: the
    // shape on the unregistered CutIndex 5 is dropped while the CutIndex 1
    // shape is kept.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
		<LightBurnProject AppVersion="1.0" FormatVersion="1">
			<CutSetting type="Cut"><index Value="1"/></CutSetting>
			<Shape Type="Rect" CutIndex="1" W="10" H="10"><XForm>1 0 0 1 0 0</XForm></Shape>
			<Shape Type="Rect" CutIndex="5" W="10" H="10"><XForm>1 0 0 1 0 0</XForm></Shape>
		</LightBurnProject>`;
    const parts = parseLightBurn(xml);
    expect(parts).toHaveLength(1);
  });

  it('reports import diagnostics for a file mixing valid and invalid shapes', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
		<LightBurnProject AppVersion="1.0" FormatVersion="1">
			<Shape Type="Rect" CutIndex="0" W="10" H="10"><XForm>1 0 0 1 0 0</XForm></Shape>
			<Shape Type="Path" CutIndex="0" VertID="9" PrimID="9"><XForm>1 0 0 1 0 0</XForm></Shape>
			<Shape Type="Path" CutIndex="0"><XForm>1 0 0 1 0 0</XForm></Shape>
		</LightBurnProject>`;
    const { parts, diagnostics } = parseLightBurnWithDiagnostics(xml);
    expect(parts).toHaveLength(1);
    expect(diagnostics.imported).toBe(1);
    expect(diagnostics.skipped).toBe(2);
    expect(diagnostics.skippedByReason['unresolved-id']).toBe(1);
    expect(diagnostics.skippedByReason['empty-primlist']).toBe(1);
  });

  it('reports a lone unstitchable open segment as an open-path skip', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
		<LightBurnProject AppVersion="1.0" FormatVersion="1">
			<Shape Type="Path" CutIndex="0"><XForm>1 0 0 1 0 0</XForm><VertList>V0 0V10 0</VertList><PrimList>L0 1</PrimList></Shape>
		</LightBurnProject>`;
    const { parts, diagnostics } = parseLightBurnWithDiagnostics(xml);
    expect(parts).toHaveLength(0);
    expect(diagnostics.imported).toBe(0);
    expect(diagnostics.skippedByReason['open-path']).toBe(1);
    expect(summarizeSkipped(diagnostics)).toBe('1 shape skipped: 1 open paths');
  });

  it('counts a fully filtered-out layer in diagnostics', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
		<LightBurnProject AppVersion="1.0" FormatVersion="1">
			<CutSetting type="Cut"><index Value="1"/></CutSetting>
			<Shape Type="Rect" CutIndex="1" W="10" H="10"><XForm>1 0 0 1 0 0</XForm></Shape>
			<Shape Type="Rect" CutIndex="5" W="10" H="10"><XForm>1 0 0 1 0 0</XForm></Shape>
		</LightBurnProject>`;
    const { parts, diagnostics } = parseLightBurnWithDiagnostics(xml);
    expect(parts).toHaveLength(1);
    expect(diagnostics.skippedByReason['filtered-layer']).toBe(1);
  });

  it('returns a null skip summary when nothing was skipped', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
		<LightBurnProject AppVersion="1.0" FormatVersion="1">
			<Shape Type="Rect" CutIndex="0" W="10" H="10"><XForm>1 0 0 1 0 0</XForm></Shape>
		</LightBurnProject>`;
    const { diagnostics } = parseLightBurnWithDiagnostics(xml);
    expect(diagnostics.skipped).toBe(0);
    expect(summarizeSkipped(diagnostics)).toBeNull();
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
