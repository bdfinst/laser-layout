import type { PlacedPart, MaterialSheet } from '$lib/geometry/types';
import { boundingBox, getPlacedPolygons } from '$lib/geometry/polygon';

// Sheet statistics for nesting results. Single source of truth for strip height and
// material utilization, consumed by both the GA fitness (optimizer) and the reported
// SheetResult (engine). Depends only on geometry — no placement/optimizer imports.

/** Compute strip height and utilization in a single pass */
export function computeSheetStats(
  placed: PlacedPart[],
  sheet: MaterialSheet,
): { stripHeight: number; utilization: number } {
  if (placed.length === 0) return { stripHeight: 0, utilization: 0 };

  let maxY = 0;
  let partsArea = 0;

  for (const pp of placed) {
    const polys = getPlacedPolygons(pp);
    for (const poly of polys) {
      const bb = boundingBox(poly);
      if (bb.maxY > maxY) maxY = bb.maxY;
      partsArea += bb.width * bb.height;
    }
  }

  const usedArea = maxY * sheet.width;
  const utilization = usedArea === 0 ? 0 : Math.min(1, partsArea / usedArea);

  return { stripHeight: maxY, utilization };
}

export function calculateUtilization(placed: PlacedPart[], sheet: MaterialSheet): number {
  return computeSheetStats(placed, sheet).utilization;
}

export function getStripHeight(placed: PlacedPart[]): number {
  if (placed.length === 0) return 0;
  let maxY = 0;
  for (const pp of placed) {
    const polys = getPlacedPolygons(pp);
    for (const poly of polys) {
      const bb = boundingBox(poly);
      if (bb.maxY > maxY) maxY = bb.maxY;
    }
  }
  return maxY;
}
