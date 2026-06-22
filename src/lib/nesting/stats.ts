import type { PlacedPart, MaterialSheet, Point } from '$lib/geometry/types';
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

// --- Common-line cutting metric (#43) ----------------------------------------
//
// When two parts abut along a straight boundary, that boundary can be cut once and serve
// both parts ("common-line cutting") — saving cut time and the kerf-width sliver of
// material between them. The GA rewards arrangements with more shared boundary, so it
// actively seeks edge-to-edge packings rather than merely dense ones. Pure geometry.

/** Length of the collinear overlap between segment a1→a2 and b1→b2, or 0 if not collinear. */
function collinearOverlap(a1: Point, a2: Point, b1: Point, b2: Point, tolerance: number): number {
  const dax = a2.x - a1.x;
  const day = a2.y - a1.y;
  const la = Math.hypot(dax, day);
  if (la < tolerance) return 0;
  const ux = dax / la;
  const uy = day / la;

  // b must be parallel to a (perpendicular deviation of b's vector small relative to tol).
  const dbx = b2.x - b1.x;
  const dby = b2.y - b1.y;
  if (Math.abs(ux * dby - uy * dbx) > tolerance) return 0;

  // b's endpoints must lie on a's infinite line (perpendicular distance ~ 0).
  const perp1 = (b1.x - a1.x) * uy - (b1.y - a1.y) * ux;
  const perp2 = (b2.x - a1.x) * uy - (b2.y - a1.y) * ux;
  if (Math.abs(perp1) > tolerance || Math.abs(perp2) > tolerance) return 0;

  // Project everything onto a's direction (param from a1) and intersect the intervals.
  const tA0 = 0;
  const tA1 = la;
  const tB0 = (b1.x - a1.x) * ux + (b1.y - a1.y) * uy;
  const tB1 = (b2.x - a1.x) * ux + (b2.y - a1.y) * uy;
  const lo = Math.max(Math.min(tA0, tA1), Math.min(tB0, tB1));
  const hi = Math.min(Math.max(tA0, tA1), Math.max(tB0, tB1));
  return Math.max(0, hi - lo);
}

/** Sum of collinear-overlap lengths between every edge of polyA and polyB. */
function pairSharedEdge(polyA: Point[], polyB: Point[], tolerance: number): number {
  let total = 0;
  for (let i = 0; i < polyA.length; i++) {
    const a1 = polyA[i];
    const a2 = polyA[(i + 1) % polyA.length];
    for (let j = 0; j < polyB.length; j++) {
      const b1 = polyB[j];
      const b2 = polyB[(j + 1) % polyB.length];
      total += collinearOverlap(a1, a2, b1, b2, tolerance);
    }
  }
  return total;
}

/**
 * Total length (mm) of boundary shared between distinct placed parts — collinear, spatially
 * overlapping edges of two different parts. Only the outer boundary of each part is
 * considered. Bounding boxes prune pairs that can't touch, so the cost is dominated by the
 * few genuinely-adjacent pairs. This is the raw signal common-line cutting maximizes.
 */
export function sharedEdgeLength(placed: PlacedPart[], tolerance: number = 0.05): number {
  const parts = placed.map((pp) => {
    const poly = getPlacedPolygons(pp)[0] ?? [];
    return { poly, bb: poly.length >= 3 ? boundingBox(poly) : null };
  });
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const A = parts[i];
    if (!A.bb) continue;
    for (let j = i + 1; j < parts.length; j++) {
      const B = parts[j];
      if (!B.bb) continue;
      // Prune: the bounding boxes must be within `tolerance` of overlapping on both axes.
      if (A.bb.minX - B.bb.maxX > tolerance || B.bb.minX - A.bb.maxX > tolerance) continue;
      if (A.bb.minY - B.bb.maxY > tolerance || B.bb.minY - A.bb.maxY > tolerance) continue;
      total += pairSharedEdge(A.poly, B.poly, tolerance);
    }
  }
  return total;
}

/**
 * Shared-edge length normalized to [0,1] against half the total outer perimeter (the most
 * boundary that could ever be shared, since each shared segment is one edge of two parts).
 * The GA rewards this directly. Returns 0 when there is no perimeter to share.
 */
export function sharedEdgeRatio(placed: PlacedPart[], tolerance: number = 0.05): number {
  let perimeter = 0;
  for (const pp of placed) {
    const poly = getPlacedPolygons(pp)[0];
    if (!poly || poly.length < 3) continue;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      perimeter += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  if (perimeter <= 0) return 0;
  return clamp(sharedEdgeLength(placed, tolerance) / (perimeter / 2), 0, 1);
}
