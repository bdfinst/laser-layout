import type { PlacedPart, MaterialSheet } from '$lib/geometry/types';
import { boundingBox, centroid, getPlacedPolygons, polygonArea } from '$lib/geometry/polygon';

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

// --- Remnant-aware metrics (#41) ---------------------------------------------
//
// A real shop cares not just about how little material a job uses, but about *where*
// the leftover ends up: one large, contiguous, rectangular offcut is reusable for the
// next job, scattered gaps are scrap. These two metrics give the GA fitness a mild,
// tunable pull toward that outcome without disturbing the dominant feasibility/density
// objectives (see optimizer.ts). Both are derived purely from geometry.

/**
 * Compactness "gravity" metric in [0,1]: the area-weighted centroid of all placed
 * parts, measured as its distance from the sheet's (0,0) corner over the sheet
 * diagonal. Lower means parts cluster tighter into the corner, which consolidates the
 * leftover space into a single offcut. Returns 0 for an empty placement (nothing to
 * pull). Uses each part's outer-boundary centroid weighted by its outer area.
 */
export function gravityMetric(placed: PlacedPart[], sheet: MaterialSheet): number {
  let sumX = 0;
  let sumY = 0;
  let sumW = 0;
  for (const pp of placed) {
    const polys = getPlacedPolygons(pp);
    if (polys.length === 0) continue;
    const weight = polygonArea(polys[0]);
    const c = centroid(polys[0]);
    sumX += c.x * weight;
    sumY += c.y * weight;
    sumW += weight;
  }
  if (sumW === 0) return 0;
  const diagonal = Math.hypot(sheet.width, sheet.height);
  if (diagonal === 0) return 0;
  const cx = sumX / sumW;
  const cy = sumY / sumW;
  return clamp(Math.hypot(cx, cy) / diagonal, 0, 1);
}

export interface RemnantStats {
  /** Area (mm²) of the largest axis-aligned empty rectangle that fits within the sheet. */
  largestRectArea: number;
  /** largestRectArea / sheet area, in [0,1]. Higher means a bigger reusable offcut. */
  largestRectRatio: number;
}

/** Default rasterization resolution for the largest-empty-rectangle scan. */
export const REMNANT_GRID_RESOLUTION = 48;

/** Largest all-empty rectangle in a binary occupancy grid, in cell units (histogram method). */
function largestEmptyRectCells(grid: boolean[][], rows: number, cols: number): number {
  const heights = new Array<number>(cols).fill(0);
  let best = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) heights[c] = grid[r][c] ? 0 : heights[c] + 1;
    best = Math.max(best, largestRectInHistogram(heights));
  }
  return best;
}

/** Largest rectangle area under a histogram (classic monotonic-stack O(n) scan). */
function largestRectInHistogram(heights: number[]): number {
  const stack: number[] = [];
  let best = 0;
  for (let i = 0; i <= heights.length; i++) {
    const h = i === heights.length ? 0 : heights[i];
    while (stack.length > 0 && heights[stack[stack.length - 1]] >= h) {
      const height = heights[stack.pop()!];
      const left = stack.length > 0 ? stack[stack.length - 1] : -1;
      const width = i - left - 1;
      best = Math.max(best, height * width);
    }
    stack.push(i);
  }
  return best;
}

/**
 * Largest contiguous reusable offcut: the largest axis-aligned empty rectangle that
 * fits on the sheet without overlapping any placed part. Parts are rasterized to their
 * (rotation-aware) outer bounding box on a coarse grid — a conservative, cheap proxy
 * that never claims remnant where a part's bbox sits. An empty placement returns the
 * whole sheet (ratio 1). This is the metric the fitness rewards via `1 - ratio`.
 */
export function remnantStats(
  placed: PlacedPart[],
  sheet: MaterialSheet,
  resolution: number = REMNANT_GRID_RESOLUTION,
): RemnantStats {
  const sheetArea = sheet.width * sheet.height;
  if (sheetArea <= 0) return { largestRectArea: 0, largestRectRatio: 0 };

  const cols = Math.max(1, resolution);
  const rows = Math.max(1, resolution);
  const cellW = sheet.width / cols;
  const cellH = sheet.height / rows;

  const grid: boolean[][] = Array.from({ length: rows }, () =>
    new Array<boolean>(cols).fill(false),
  );
  for (const pp of placed) {
    const polys = getPlacedPolygons(pp);
    if (polys.length === 0) continue;
    const bb = boundingBox(polys[0]);
    const c0 = clampInt(Math.floor(bb.minX / cellW), 0, cols - 1);
    const c1 = clampInt(Math.floor((bb.maxX - 1e-9) / cellW), 0, cols - 1);
    const r0 = clampInt(Math.floor(bb.minY / cellH), 0, rows - 1);
    const r1 = clampInt(Math.floor((bb.maxY - 1e-9) / cellH), 0, rows - 1);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) grid[r][c] = true;
    }
  }

  const cells = largestEmptyRectCells(grid, rows, cols);
  const largestRectArea = cells * cellW * cellH;
  return { largestRectArea, largestRectRatio: clamp(largestRectArea / sheetArea, 0, 1) };
}

function clampInt(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}
