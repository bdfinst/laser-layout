import type { PlacedPart, MaterialSheet } from '$lib/geometry/types';
import { boundingBox, getPlacedPolygons, polygonArea } from '$lib/geometry/polygon';

// Sheet statistics for nesting results. Single source of truth for strip height and
// material utilization, consumed by both the GA fitness (optimizer) and the reported
// SheetResult (engine). Depends only on geometry — no placement/optimizer imports.
//
// partsArea uses TRUE polygon area: per the getPlacedPolygons convention,
// polygons[0] is the outer boundary and polygons[1..] are cutouts. polygonArea() is
// always positive, so cutout areas are SUBTRACTED from the outer area (never summed).

export interface OpenAreaStats {
  stripHeight: number;
  partsArea: number;
  usedArea: number;
  openAreaRatio: number;
  utilization: number;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Density metric for a placement. The number the GA minimizes (via openAreaRatio)
 * and the reported utilization (1 - openAreaRatio) both come from here.
 */
/** Max-Y extent of all placed parts — the single strip-height implementation. */
function stripHeightOf(placed: PlacedPart[]): number {
  let maxY = 0;
  for (const pp of placed) {
    for (const poly of getPlacedPolygons(pp)) {
      const bb = boundingBox(poly);
      if (bb.maxY > maxY) maxY = bb.maxY;
    }
  }
  return maxY;
}

export function openAreaStats(placed: PlacedPart[], sheet: MaterialSheet): OpenAreaStats {
  if (placed.length === 0) {
    return { stripHeight: 0, partsArea: 0, usedArea: 0, openAreaRatio: 1, utilization: 0 };
  }

  let partsArea = 0;
  for (const pp of placed) {
    const polys = getPlacedPolygons(pp);
    if (polys.length === 0) continue;

    // True area: outer boundary minus interior cutouts.
    let area = polygonArea(polys[0]);
    for (let i = 1; i < polys.length; i++) {
      area -= polygonArea(polys[i]);
    }
    partsArea += area;
  }

  const stripHeight = stripHeightOf(placed);
  const usedArea = stripHeight * sheet.width;
  const openAreaRatio = usedArea > 0 ? clamp((usedArea - partsArea) / usedArea, 0, 1) : 1;
  const utilization = 1 - openAreaRatio;

  return { stripHeight, partsArea, usedArea, openAreaRatio, utilization };
}

/** Compute strip height and utilization (delegates to the shared density metric). */
export function computeSheetStats(
  placed: PlacedPart[],
  sheet: MaterialSheet,
): { stripHeight: number; utilization: number } {
  const { stripHeight, utilization } = openAreaStats(placed, sheet);
  return { stripHeight, utilization };
}

export function calculateUtilization(placed: PlacedPart[], sheet: MaterialSheet): number {
  return computeSheetStats(placed, sheet).utilization;
}

export function getStripHeight(placed: PlacedPart[]): number {
  return stripHeightOf(placed);
}
