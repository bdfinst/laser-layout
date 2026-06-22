import type { PlacedPart, Point } from '$lib/geometry/types';
import { getPlacedPolygons } from '$lib/geometry/polygon';

/** Default coincidence tolerance (mm) for treating two edges as the same cut. */
export const COMMON_LINE_TOLERANCE = 0.05;

/**
 * Collapse a placement into its set of unique cut edges for common-line cutting (#43).
 *
 * Every part polygon contributes its boundary edges; edges that coincide (same endpoints
 * within `tolerance`, in either direction) are emitted once instead of twice, so a shared
 * boundary between two abutting parts becomes a single cut. Endpoints are quantized to a
 * `tolerance` grid to build the dedup key. Returns the unique segments as endpoint pairs.
 *
 * This handles fully-coincident shared edges (the dominant common-line case: identical
 * parts placed edge-to-edge). Partially-overlapping edges are kept separate — never
 * double-removed — so the result is always a superset-safe, overlap-free cut set.
 */
export function dedupeCommonLineEdges(
  placed: PlacedPart[],
  tolerance: number = COMMON_LINE_TOLERANCE,
): [Point, Point][] {
  const q = tolerance > 0 ? 1 / tolerance : 1e6;
  const keyOf = (p: Point) => `${Math.round(p.x * q)},${Math.round(p.y * q)}`;
  const seen = new Set<string>();
  const segments: [Point, Point][] = [];

  for (const pp of placed) {
    for (const poly of getPlacedPolygons(pp)) {
      if (poly.length < 2) continue;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const ka = keyOf(a);
        const kb = keyOf(b);
        if (ka === kb) continue; // zero-length edge after quantization
        // Direction-independent key so A→B and B→A are the same cut.
        const edgeKey = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        if (seen.has(edgeKey)) continue;
        seen.add(edgeKey);
        segments.push([a, b]);
      }
    }
  }

  return segments;
}
