import type { Point, Polygon } from '$lib/geometry/types';
import { Clipper, FillRule, JoinType, EndType, type Path64, type Paths64 } from 'clipper2-js';

/**
 * Exact NFP-union feasible-region placement (epic #24, P0 of #26).
 *
 * The per-pair anchor enumeration in `placement.ts` can only propose vertices of an
 * *individual* No-Fit Polygon. The genuinely tightest interlocking seats — where the moving
 * part beds against two placed parts at once — are vertices of the *union* of the pair-NFPs
 * that belong to no single NFP, so the anchor path can never generate them (the #26
 * diagnostic measured a 0% budget-bite rate: candidates aren't discarded, they're never
 * created). This module builds the exact feasible region for the moving part's reference
 * point and returns its vertices, every one an exact touching/kerf-clearance seat:
 *
 *   feasible   = IFP_rect  −  union( dilate(NFP_i, kerf) translated to world )
 *   candidates = vertices(feasible)
 *
 * The IFP (inner-fit polygon) of a rectangular sheet is, for a part normalized to its
 * bbox-min, exactly the axis-aligned rectangle [0, W−w] × [0, H−h] — so no polygon IFP is
 * needed. Kerf is a uniform outward dilation of each NFP by a round (disk) join, i.e. an exact
 * Minkowski-with-a-disk clearance.
 *
 * **Per-pair dilation cache (perf).** Dilation distributes over union — `dilate(∪ NFP_i) =
 * ∪ dilate(NFP_i)` — and each `dilate(NFP_i, kerf)` depends only on the shape pair and the
 * (per-nest constant) kerf, so it is translation-invariant. We dilate+simplify each pair-NFP
 * once into clipper space and cache it; per placement we only translate the cached paths
 * (integer adds) and run a *single* `Difference` (clipper unions the clip paths internally).
 * That replaces the old per-placement union + inflate + simplify + difference (4 clipper
 * passes) with 1, and moves the expensive InflatePaths/simplify off the hot path.
 *
 * Robustness comes from clipper2 (integer boolean ops); inputs are quantized to SCALE.
 */

// Integer scale for clipper (micron precision at mm inputs). Sheet coords reach ~760 mm →
// 760_000, and NFP offsets a few sheet-widths — all well inside the safe integer range.
const SCALE = 1000;

// Collapse the dense arc vertices the round kerf join emits at every convex corner (otherwise
// each corner becomes ~30 candidates). The chord this drops cuts a corner by at most this much,
// which can shave a hair off the kerf clearance at a diagonal corner — harmless because the
// caller re-validates every chosen candidate with the exact kerf-clearance test (`hasCollision`),
// so an over-cut corner seat is simply rejected, never accepted under-spaced.
const SIMPLIFY_EPS = SCALE * 0.1;

function toClipperPath(poly: Polygon): Path64 {
  const flat: number[] = [];
  for (const p of poly) {
    flat.push(Math.round(p.x * SCALE), Math.round(p.y * SCALE));
  }
  return Clipper.makePath(flat);
}

/** Clipper expands outward only when a ring is positively oriented; normalize before inflate/union. */
function orientPositive(path: Path64): Path64 {
  return Clipper.isPositive(path) ? path : Clipper.reversePath(path);
}

export interface IfpRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A placed part's NFP against the moving part, with its world offset and a per-pair cache key. */
export interface ForbiddenNfp {
  /** The pair-NFP in the placed part's local frame (locus of moving reference offsets). */
  nfp: Polygon;
  /** World origin of the placed part — the NFP is translated by this to reach sheet coords. */
  offx: number;
  offy: number;
  /** Stable per-pair key (placed-sig | moving-sig); the dilation is cached under it. */
  key: string;
}

/**
 * The kerf-dilated NFP for one pair, in clipper space at the pair's local origin. Cached in the
 * per-nest `dilatedCache` so the InflatePaths + simplify runs once per pair, not per placement.
 */
function dilatedPaths(
  dilatedCache: Map<string, unknown>,
  key: string,
  nfp: Polygon,
  kerf: number,
): Paths64 {
  const cached = dilatedCache.get(key);
  if (cached !== undefined) return cached as Paths64;

  const base = orientPositive(toClipperPath(nfp));
  let paths: Paths64;
  if (kerf > 0) {
    const inflated = Clipper.InflatePaths([base], kerf * SCALE, JoinType.Round, EndType.Polygon);
    // Trim the round-join arcs so each corner contributes ~1 candidate, not ~30.
    paths = Clipper.simplifyPaths(inflated, SIMPLIFY_EPS, false).map(orientPositive);
  } else {
    paths = [base];
  }
  dilatedCache.set(key, paths);
  return paths;
}

const RECT_CORNERS = (ifp: IfpRect): Point[] => [
  { x: ifp.x0, y: ifp.y0 },
  { x: ifp.x1, y: ifp.y0 },
  { x: ifp.x0, y: ifp.y1 },
  { x: ifp.x1, y: ifp.y1 },
];

/**
 * Candidate reference-point positions for the moving part: the vertices of
 * `IFP_rect − union(dilate(NFP_i, kerf))`. Returns an empty array when the part cannot fit the
 * sheet or the feasible region is empty (the caller then falls back to the legacy anchor path).
 */
export function feasibleVertices(
  forbidden: ForbiddenNfp[],
  ifp: IfpRect,
  kerf: number,
  dilatedCache: Map<string, unknown>,
): Point[] {
  // Part bigger than the sheet → no inner-fit rectangle.
  if (ifp.x1 < ifp.x0 || ifp.y1 < ifp.y0) return [];

  const rect = orientPositive(
    toClipperPath([
      { x: ifp.x0, y: ifp.y0 },
      { x: ifp.x1, y: ifp.y0 },
      { x: ifp.x1, y: ifp.y1 },
      { x: ifp.x0, y: ifp.y1 },
    ]),
  );

  // Collect the kerf-dilated, world-translated forbidden paths. One Difference subtracts their
  // union from the IFP rect (clipper unions the clip set internally).
  const clips: Paths64 = [];
  for (const f of forbidden) {
    if (f.nfp.length < 3) continue;
    const local = dilatedPaths(dilatedCache, f.key, f.nfp, kerf);
    const moved = Clipper.translatePaths(
      local,
      Math.round(f.offx * SCALE),
      Math.round(f.offy * SCALE),
    );
    for (const p of moved) clips.push(p);
  }

  // Nothing placed yet (or no NFP built): the whole IFP rectangle is feasible; its corners are
  // the candidates (bottom-left is the origin, preserving the legacy preference).
  if (clips.length === 0) return RECT_CORNERS(ifp);

  const feasible = Clipper.Difference([rect], clips, FillRule.NonZero);
  if (feasible.length === 0) return [];

  // Every vertex of the feasible region (outer rings and the boundaries of any interior holes —
  // those are valid pocket seats) is an exact candidate. Dedupe on the integer grid.
  const seen = new Set<number>();
  const out: Point[] = [];
  for (const path of feasible) {
    for (const pt of path) {
      const k = pt.x * 4_000_003 + pt.y;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ x: pt.x / SCALE, y: pt.y / SCALE });
    }
  }
  return out;
}
