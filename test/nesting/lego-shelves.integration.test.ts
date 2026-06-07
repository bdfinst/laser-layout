import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseLightBurn } from '$lib/parsers/lightburn-parser';
import { groupByContainment, removeCoincidentDuplicates } from '$lib/geometry/grouping';
import { deduplicateParts } from '$lib/geometry/dedup';
import { nestParts } from '$lib/nesting/engine';
import { getPlacedPolygons } from '$lib/geometry/polygon';
import { polygonContainsPolygon } from '$lib/nesting/nfp';
import type { NestingConfig, Part } from '$lib/geometry/types';

// The panels are up to ~209 x 445 mm, so the sheet must be large enough to fit
// the largest part; otherwise oversized parts legitimately overflow.
const CONFIG: NestingConfig = {
  sheet: { width: 500, height: 500 },
  kerf: 1,
  rotationSteps: 72,
  populationSize: 30,
  generations: 40,
};

function pipeline(): Part[] {
  const xml = readFileSync(resolve('test-fixtures/lego-shelves.lbrn2'), 'utf-8');
  return groupByContainment(removeCoincidentDuplicates(parseLightBurn(xml)));
}

describe('Lego shelves end-to-end nesting', () => {
  const grouped = pipeline();

  it('removes coincident duplicate lines and groups cutouts', () => {
    // 54 paths -> 34 unique shapes (every shape is drawn twice) ->
    // 12 parts (4 panels carrying cutouts + 8 boards), 34 polygons total.
    expect(grouped.length).toBe(12);
    const totalPolys = grouped.reduce((s, p) => s + p.polygons.length, 0);
    expect(totalPolys).toBe(34);
    // The panels carry their interior slot cutouts.
    expect(grouped.some((p) => p.polygons.length > 1)).toBe(true);
  });

  it('nests every part with no overflow', () => {
    const { uniqueParts, quantities } = deduplicateParts(grouped);
    const totalInstances = [...quantities.values()].reduce((a, b) => a + b, 0);
    expect(totalInstances).toBe(12);

    const result = nestParts({ parts: uniqueParts, quantities, config: CONFIG });
    expect(result.unplaced).toHaveLength(0);
    expect(result.totalPlaced).toBe(12);
  });

  it('keeps every cutout inside its parent after placement', () => {
    const { uniqueParts, quantities } = deduplicateParts(grouped);
    const result = nestParts({ parts: uniqueParts, quantities, config: CONFIG });

    for (const sheet of result.sheets) {
      for (const pp of sheet.placed) {
        const polys = getPlacedPolygons(pp);
        const outer = polys[0];
        for (let i = 1; i < polys.length; i++) {
          expect(polygonContainsPolygon(outer, polys[i])).toBe(true);
        }
      }
    }
  });
});
