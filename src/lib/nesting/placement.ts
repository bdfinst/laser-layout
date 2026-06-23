import type { Point, Polygon, Part, PlacedPart, MaterialSheet } from '$lib/geometry/types';
import {
  boundingBox,
  rotatePolygon,
  translatePolygon,
  transformPartPolygons,
  reflectPolygon,
} from '$lib/geometry/polygon';
import type { BoundingBox } from '$lib/geometry/types';
import {
  polygonsInterpenetrate,
  polygonsCloserThan,
  reflexVertices,
  insetPolygon as computeInsetPolygon,
  polygonContainsPolygon,
  pointInPolygon,
} from './nfp';
import type { NfpCache } from './nfp-cache';
import { recordBudgetOutcome } from './instrumentation';
import { feasibleVertices, type IfpRect, type ForbiddenNfp } from './nfp-feasible';

interface CachedPlacement {
  pp: PlacedPart;
  polygon: Polygon;
  bb: BoundingBox;
  // Outer polygon normalized to the origin (bbox min at 0,0), placed at (bb.minX, bb.minY).
  // Used as the *static* polygon when computing this part's NFP against a moving part.
  localPoly: Polygon;
  // Geometry signature of localPoly — the NFP cache key component (instance-unifying:
  // identical shapes at the same rotation share one cached NFP). Empty when NFP is off.
  sig: string;
}

interface CachedHole {
  sourcePlacementIndex: number;
  holePolygon: Polygon;
  holeBB: BoundingBox;
  insetPoly: Polygon;
  insetBB: BoundingBox;
  innerPlacements: CachedPlacement[];
}

interface PlacementResult {
  position: Point;
  hole: CachedHole | null;
}

/**
 * Per-nest NFP context for the part currently being placed (epic #24, P3–P5). Present
 * only on the EXACT collision path with a cache supplied; absent (`undefined`) for the
 * fast bbox search and for all callers that don't opt in, so their behavior is byte-for-
 * byte unchanged. `movingPoly` is the moving part's outer polygon normalized to origin.
 */
interface NfpCtx {
  cache: NfpCache;
  movingSig: string;
  movingPoly: Polygon;
}

const NFP_EPS = 1e-6;

// Uniform-grid resolution (#42): the grid spans the shorter sheet side in this many cells,
// so a cell is roughly part-sized for typical jobs — each placement touches a handful of
// cells and each collision query returns O(1) neighbours instead of scanning all placements.
const GRID_RESOLUTION = 32;

/**
 * Uniform-grid spatial index over placed parts (#42). `hasCollision` queries it for only the
 * placements whose bounding boxes share a grid cell with the kerf-expanded query box, turning
 * the per-candidate collision scan from O(N_placed) into a local lookup. The grid is
 * deliberately *conservative*: it returns a superset of the placements within `kerf` of the
 * query, never fewer. Since the subsequent `checkOverlap` re-applies the exact bbox-reject +
 * shape/NFP test to each returned candidate (and every omitted placement would have been
 * rejected by that bbox test anyway), the collision result is byte-for-byte identical to the
 * old full scan — the optimization is behaviour-preserving.
 */
interface PlacedIndex {
  /** All placements in insertion order (read by the candidate-anchor / union passes). */
  readonly items: CachedPlacement[];
  /** Record a newly placed part in both the item list and the grid. */
  add(cp: CachedPlacement): void;
  /**
   * Placements whose cells meet the kerf-expanded query box. The returned array is a shared
   * buffer — consume it before the next `query` call (all callers do so synchronously).
   */
  query(bb: BoundingBox, kerf: number): CachedPlacement[];
}

function createPlacedIndex(sheet: MaterialSheet): PlacedIndex {
  const span = Math.min(sheet.width, sheet.height);
  const cell = Math.max(1, span / GRID_RESOLUTION);
  const cols = Math.max(1, Math.ceil(sheet.width / cell) + 1);
  const items: CachedPlacement[] = [];
  const buckets = new Map<number, number[]>();
  // Per-query dedupe stamps: a placement spanning several cells must be returned once. The
  // generation counter avoids clearing the array between queries.
  let stamps = new Int32Array(0);
  let queryGen = 0;
  // Reused output buffer — a query's result must be consumed before the next query.
  const scratch: CachedPlacement[] = [];

  const col = (x: number): number => {
    const c = Math.floor(x / cell);
    return c < 0 ? 0 : c >= cols ? cols - 1 : c;
  };
  const row = (y: number): number => {
    const r = Math.floor(y / cell);
    return r < 0 ? 0 : r;
  };
  const key = (cx: number, cy: number): number => cy * cols + cx;

  const add = (cp: CachedPlacement): void => {
    const idx = items.length;
    items.push(cp);
    const x0 = col(cp.bb.minX);
    const x1 = col(cp.bb.maxX);
    const y0 = row(cp.bb.minY);
    const y1 = row(cp.bb.maxY);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const k = key(cx, cy);
        const bucket = buckets.get(k);
        if (bucket) bucket.push(idx);
        else buckets.set(k, [idx]);
      }
    }
  };

  const query = (bb: BoundingBox, kerf: number): CachedPlacement[] => {
    if (stamps.length < items.length) {
      const next = new Int32Array(items.length * 2 + 8);
      next.set(stamps);
      stamps = next;
    }
    const gen = ++queryGen;
    scratch.length = 0;
    const x0 = col(bb.minX - kerf);
    const x1 = col(bb.maxX + kerf);
    const y0 = row(bb.minY - kerf);
    const y1 = row(bb.maxY + kerf);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const bucket = buckets.get(key(cx, cy));
        if (!bucket) continue;
        for (const idx of bucket) {
          if (stamps[idx] === gen) continue;
          stamps[idx] = gen;
          scratch.push(items[idx]);
        }
      }
    }
    return scratch;
  };

  return { items, add, query };
}

interface PositionHeap {
  readonly size: number;
  pop(): ScoredPosition;
}

/**
 * Binary min-heap of candidate positions (#42, partial-sort). `tryAdjacentPositions` only ever
 * consumes a bounded prefix of the candidates in `better`-order (it stops once the validate
 * budget is met), so building a heap in O(N) and extracting the few it needs in O(log N) each
 * beats fully sorting all candidates O(N log N). Extraction order matches the old stable sort
 * for every candidate that differs; the only ties are candidates at the *same* (x, y), which
 * resolve to an identical placement regardless of order — so the result is behaviour-preserving.
 * Heapifies `d` in place.
 */
function createPositionHeap(
  d: ScoredPosition[],
  less: (a: ScoredPosition, b: ScoredPosition) => boolean,
): PositionHeap {
  const siftDown = (start: number): void => {
    const n = d.length;
    let i = start;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let m = i;
      if (l < n && less(d[l], d[m])) m = l;
      if (r < n && less(d[r], d[m])) m = r;
      if (m === i) break;
      const tmp = d[i];
      d[i] = d[m];
      d[m] = tmp;
      i = m;
    }
  };

  for (let i = (d.length >> 1) - 1; i >= 0; i--) siftDown(i);

  return {
    get size(): number {
      return d.length;
    },
    pop(): ScoredPosition {
      const top = d[0];
      const last = d.pop()!;
      if (d.length > 0) {
        d[0] = last;
        siftDown(0);
      }
      return top;
    },
  };
}

/** Quantized vertex signature — stable, instance-unifying NFP cache key for a polygon. */
function polySignature(poly: Polygon): string {
  let s = '';
  for (let i = 0; i < poly.length; i++) {
    s += Math.round(poly[i].x * 64) + ',' + Math.round(poly[i].y * 64) + ';';
  }
  return s;
}

/** Fetch (and cache) the NFP of a placed part (static) vs the moving part (orbiting). */
function nfpFor(ctx: NfpCtx, cp: CachedPlacement): Polygon | null {
  if (!cp.sig) return null;
  return ctx.cache.get(
    { partA: cp.sig, rotA: 0, partB: ctx.movingSig, rotB: 0 },
    cp.localPoly,
    ctx.movingPoly,
  );
}

function pointToBoundaryDistance(p: Point, poly: Polygon): number {
  let min = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = p.x - (a.x + t * dx);
    const ey = p.y - (a.y + t * dy);
    const d2 = ex * ex + ey * ey;
    if (d2 < min) min = d2;
  }
  return Math.sqrt(min);
}

/**
 * Signed clearance of translation `t` against an NFP: negative when `t` is inside the
 * NFP (the parts overlap), positive when outside (the gap between the parts). This is the
 * NFP-as-configuration-space-obstacle property: the distance from a free configuration to
 * the NFP boundary equals the real separation between the two parts. Lets one cheap
 * point/distance test replace the O(edgesA·edgesB) true-shape collision (P5), and handle
 * kerf spacing uniformly: collide iff `clearance < kerf − ε`.
 */
function nfpClearance(t: Point, nfp: Polygon): number {
  const d = pointToBoundaryDistance(t, nfp);
  return pointInPolygon(t, nfp) ? -d : d;
}

export function bottomLeftFill(
  parts: { part: Part; rotation: number; mirror?: boolean }[],
  sheet: MaterialSheet,
  kerf: number = 0,
  exact: boolean = true,
  nfpCache: NfpCache | null = null,
): PlacedPart[] {
  const placed: PlacedPart[] = [];
  const cache = createPlacedIndex(sheet);
  let holes: CachedHole[] = [];
  const useNfp = exact && nfpCache != null;

  for (const { part, rotation, mirror } of parts) {
    // Orientation-retry (density path only): a part whose gene rotation can't be placed at
    // all may still fit a tall pocket when turned 90° (observed on lego-shelves: ~190×104
    // panels that only seat portrait). This is a strict RESCUE — the orthogonal is tried
    // only when the gene rotation fails to place, so placements that already succeed are
    // untouched and other fixtures don't regress. Off the NFP path the fast bbox search and
    // all non-opt-in callers stay byte-for-byte unchanged.
    const rotationsToTry = useNfp ? [rotation, rotation + Math.PI / 2] : [rotation];

    let chosen: {
      rotation: number;
      normalized: Polygon;
      partW: number;
      partH: number;
      sig: string;
      result: PlacementResult;
      top: number;
    } | null = null;

    for (const rot of rotationsToTry) {
      const outerPoly = mirror ? reflectPolygon(part.polygons[0]) : part.polygons[0];
      const rotated = rotatePolygon(outerPoly, rot);
      const bb = boundingBox(rotated);
      const normalized = translatePolygon(rotated, -bb.minX, -bb.minY);
      const partW = bb.width;
      const partH = bb.height;

      if (partW > sheet.width || partH > sheet.height) continue;

      const sig = useNfp ? polySignature(normalized) : '';
      const nfpCtx: NfpCtx | undefined =
        useNfp && nfpCache
          ? { cache: nfpCache, movingSig: sig, movingPoly: normalized }
          : undefined;

      const result = findBestPosition(
        normalized,
        { width: partW, height: partH },
        cache,
        holes,
        sheet,
        kerf,
        exact,
        nfpCtx,
      );
      if (!result) continue;
      chosen = { rotation: rot, normalized, partW, partH, sig, result, top: 0 };
      break; // gene rotation preferred; orthogonal is a rescue only when it fails to place
    }

    if (chosen) {
      const { rotation: rot, normalized, partW, partH, sig, result } = chosen;
      const pp: PlacedPart = {
        part,
        x: result.position.x,
        y: result.position.y,
        rotation: rot,
        mirror,
      };
      placed.push(pp);
      const finalPoly = translatePolygon(normalized, result.position.x, result.position.y);
      const finalBB: BoundingBox = {
        minX: result.position.x,
        minY: result.position.y,
        maxX: result.position.x + partW,
        maxY: result.position.y + partH,
        width: partW,
        height: partH,
      };
      const cp: CachedPlacement = {
        pp,
        polygon: finalPoly,
        bb: finalBB,
        localPoly: normalized,
        sig,
      };
      cache.add(cp);

      if (result.hole) {
        result.hole.innerPlacements.push(cp);
      } else {
        // Only extract holes from parts placed on the sheet (no recursive nesting)
        const newHoles = extractHoles(
          part,
          rot,
          result.position,
          cache.items.length - 1,
          kerf,
          mirror,
        );
        holes = [...holes, ...newHoles];
      }
    }
  }

  return placed;
}

function extractHoles(
  part: Part,
  rotation: number,
  position: Point,
  sourcePlacementIndex: number,
  kerf: number,
  mirror?: boolean,
): CachedHole[] {
  if (part.polygons.length <= 1) return [];

  // Transform the whole part as a rigid body so holes keep their position
  // relative to the outer boundary (index 0 = outer boundary, 1.. = holes).
  const placedPolys = transformPartPolygons(
    part.polygons,
    rotation,
    position.x,
    position.y,
    mirror,
  );
  const result: CachedHole[] = [];

  for (let i = 1; i < placedPolys.length; i++) {
    const sheetHole = placedPolys[i];
    const sheetHoleBB = boundingBox(sheetHole);

    const inset = kerf > 0 ? computeInsetPolygon(sheetHole, kerf) : sheetHole;
    if (inset.length === 0) continue; // hole too small after kerf inset

    result.push({
      sourcePlacementIndex,
      holePolygon: sheetHole,
      holeBB: sheetHoleBB,
      insetPoly: inset,
      insetBB: boundingBox(inset),
      innerPlacements: [],
    });
  }

  return result;
}

// --- Phase helpers for findBestPosition ---

function tryHolePlacement(
  normalizedPoly: Polygon,
  partBB: { width: number; height: number },
  holes: CachedHole[],
  kerf: number,
  exact: boolean,
): PlacementResult | null {
  const holeCandidates: { x: number; y: number; score: number; hole: CachedHole }[] = [];

  for (const hole of holes) {
    if (partBB.width > hole.insetBB.width || partBB.height > hole.insetBB.height) continue;

    const hx = hole.insetBB.minX;
    const hy = hole.insetBB.minY;
    const mx = hole.insetBB.maxX - partBB.width;
    const my = hole.insetBB.maxY - partBB.height;

    const corners = [
      { x: hx, y: hy },
      { x: mx, y: hy },
      { x: hx, y: my },
      { x: mx, y: my },
      { x: (hx + mx) / 2, y: (hy + my) / 2 },
    ];

    for (const pos of corners) {
      const translated = translatePolygon(normalizedPoly, pos.x, pos.y);
      if (!polygonContainsPolygon(hole.insetPoly, translated)) continue;

      const translatedBB: BoundingBox = {
        minX: pos.x,
        minY: pos.y,
        maxX: pos.x + partBB.width,
        maxY: pos.y + partBB.height,
        width: partBB.width,
        height: partBB.height,
      };
      if (checkOverlap(translated, translatedBB, hole.innerPlacements, kerf, exact)) continue;

      const holeArea = hole.holeBB.width * hole.holeBB.height;
      holeCandidates.push({ ...pos, score: -1e9 + holeArea, hole });
    }
  }

  if (holeCandidates.length === 0) return null;

  holeCandidates.sort((a, b) => a.score - b.score);
  const best = holeCandidates[0];
  return { position: { x: best.x, y: best.y }, hole: best.hole };
}

/**
 * Generate candidate anchor positions around a single placed part. Includes the
 * legacy bounding-box corners (to the right of / above the part) plus interior-gap
 * anchors that sit to the LEFT of and BELOW the part, so a later part can settle
 * into a pocket rather than only at exterior corners.
 */
function candidateAnchors(
  cp: CachedPlacement,
  partBB: { width: number; height: number },
  kerf: number,
): Point[] {
  return [
    // Legacy corners: right of / above the placed part.
    { x: cp.bb.maxX + kerf, y: cp.bb.minY },
    { x: cp.bb.minX, y: cp.bb.maxY + kerf },
    { x: cp.bb.maxX + kerf, y: cp.bb.maxY + kerf },
    { x: cp.bb.maxX + kerf, y: 0 },
    { x: 0, y: cp.bb.maxY + kerf },
    // Interior-gap anchors: left of the placed part (bottom- and top-aligned).
    { x: cp.bb.minX - kerf - partBB.width, y: cp.bb.minY },
    { x: cp.bb.minX - kerf - partBB.width, y: cp.bb.maxY - partBB.height },
    // Interior-gap anchors: below the placed part (left- and right-aligned).
    { x: cp.bb.minX, y: cp.bb.minY - kerf - partBB.height },
    { x: cp.bb.maxX - partBB.width, y: cp.bb.minY - kerf - partBB.height },
  ];
}

/**
 * Concavity anchors (#12): seat each of the part's four corners at every reflex (notch)
 * vertex of a placed part, so the part can tuck into a concavity. Invalid seatings are
 * rejected by the exact collision check; valid ones are settled by the slide.
 */
function concavityAnchors(cp: CachedPlacement, partBB: { width: number; height: number }): Point[] {
  const out: Point[] = [];
  for (const r of reflexVertices(cp.polygon)) {
    out.push(
      { x: r.x, y: r.y },
      { x: r.x - partBB.width, y: r.y },
      { x: r.x, y: r.y - partBB.height },
      { x: r.x - partBB.width, y: r.y - partBB.height },
    );
  }
  return out;
}

/**
 * NFP candidate anchors (epic #24, P3): the complete set of touching positions where the
 * moving part beds against the placed part `cp`, including the deep concave seats that
 * bbox-corner / reflex anchors can't express. Each NFP vertex is an offset (in cp's local
 * frame) where the parts just touch; we shift it to the sheet by cp's world origin and,
 * for kerf > 0, push it outward along the NFP boundary so the touching becomes a kerf gap.
 * Exact collision still validates every candidate and the slide settles it.
 */
function nfpCandidateAnchors(nfp: Polygon, offx: number, offy: number, kerf: number): Point[] {
  const out: Point[] = [];
  const n = nfp.length;
  for (let i = 0; i < n; i++) {
    const v = nfp[i];
    let px = v.x;
    let py = v.y;
    if (kerf > 0) {
      const pushed = pushOutward(nfp[(i - 1 + n) % n], v, nfp[(i + 1) % n], nfp, kerf);
      px = pushed.x;
      py = pushed.y;
    }
    out.push({ x: px + offx, y: py + offy });
  }
  return out;
}

/** Push an NFP vertex outward (out of the overlap region) by `dist` along its bisector. */
function pushOutward(prev: Point, curr: Point, next: Point, nfp: Polygon, dist: number): Point {
  const e1x = curr.x - prev.x;
  const e1y = curr.y - prev.y;
  const e2x = next.x - curr.x;
  const e2y = next.y - curr.y;
  const l1 = Math.hypot(e1x, e1y) || 1;
  const l2 = Math.hypot(e2x, e2y) || 1;
  let nx = e1y / l1 + e2y / l2;
  let ny = -(e1x / l1) - e2x / l2;
  const nl = Math.hypot(nx, ny);
  if (nl < 1e-9) {
    nx = e1y / l1;
    ny = -e1x / l1;
  } else {
    nx /= nl;
    ny /= nl;
  }
  let cand = { x: curr.x + nx * dist, y: curr.y + ny * dist };
  if (pointInPolygon(cand, nfp)) cand = { x: curr.x - nx * dist, y: curr.y - ny * dist };
  return cand;
}

/** Bounding box enclosing all currently placed parts (for the compactness metric). */
function placedUnionBB(cache: CachedPlacement[]): BoundingBox | null {
  if (cache.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const cp of cache) {
    if (cp.bb.minX < minX) minX = cp.bb.minX;
    if (cp.bb.minY < minY) minY = cp.bb.minY;
    if (cp.bb.maxX > maxX) maxX = cp.bb.maxX;
    if (cp.bb.maxY > maxY) maxY = cp.bb.maxY;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Resulting strip height if a candidate part (top at y+h) joins the placed union. The GA
 * fitness rewards low strip height (open-area ratio = waste over stripHeight·width), so
 * the compactness metric (P4) minimizes exactly this — a pocket seat that tucks under the
 * current ceiling keeps it flat and wins over an exterior spot that raises it.
 */
function resultingStrip(u: BoundingBox | null, y: number, h: number): number {
  return u ? Math.max(u.maxY, y + h) : y + h;
}

/**
 * Coarse-step bottom-left slide: from a known collision-free position, repeatedly
 * step down while still collision-free, then step left while still collision-free.
 * `hasCollision` enforces both the sheet boundary and part collisions, so the slide
 * can never leave the sheet or create an overlap. Step and iteration count are both
 * bounded so cost stays controlled (bottomLeftFill runs once per GA individual).
 */
function slideBottomLeft(
  poly: Polygon,
  x: number,
  y: number,
  partBB: { width: number; height: number },
  cache: PlacedIndex,
  sheet: MaterialSheet,
  kerf: number,
  exact: boolean,
  nfpCtx?: NfpCtx,
): Point {
  const step = Math.max(1, Math.min(partBB.width, partBB.height) / 4);
  // Bound iterations to what the sheet can physically accommodate (never more than the
  // sheet's longest side / step), so the cap stays tight regardless of sheet size.
  const MAX_STEPS = Math.ceil(Math.max(sheet.width, sheet.height) / step) + 1;

  let cx = x;
  let cy = y;

  // Alternate down/left until neither frees further movement (fixed point). A left move
  // can open vertical room and vice-versa, so one pass misses L-shaped pockets (#14).
  // Most settling happens in the first round or two; cap to bound cost.
  const MAX_ROUNDS = 3;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const prevX = cx;
    const prevY = cy;
    let i = 0;
    while (
      i++ < MAX_STEPS &&
      !hasCollision(poly, cx, cy - step, cache, sheet, kerf, exact, nfpCtx)
    ) {
      cy -= step;
    }
    i = 0;
    while (
      i++ < MAX_STEPS &&
      !hasCollision(poly, cx - step, cy, cache, sheet, kerf, exact, nfpCtx)
    ) {
      cx -= step;
    }
    if (cx === prevX && cy === prevY) break; // converged
  }

  return { x: cx, y: cy };
}

interface ScoredPosition {
  x: number;
  y: number;
  strip: number; // resulting strip height (compactness; P4) — 0 when NFP/compactness is off
  bl: number; // bottom-left score (tiebreak / sole criterion without NFP)
}

function tryAdjacentPositions(
  normalizedPoly: Polygon,
  partBB: { width: number; height: number },
  cache: PlacedIndex,
  sheet: MaterialSheet,
  kerf: number,
  exact: boolean,
  nfpCtx?: NfpCtx,
): PlacementResult | null {
  // Generate candidate positions (cheap): bbox corners + interior-gap anchors (gap-fill)
  // + concavity anchors (#12) + — on the exact NFP path — full NFP touching anchors (#24,
  // P3) that include the deep pocket seats. Validation is expensive (true-shape / NFP
  // collision), so we cap how many positions we validate and slide rather than checking
  // every one.
  const bl = (x: number, y: number) => y * sheet.width + x;
  const union = nfpCtx ? placedUnionBB(cache.items) : null;
  const positions: { x: number; y: number }[] = [];

  // NFP-union feasible-region path (P0, #26). Instead of enumerating per-pair anchors — which
  // can only ever propose vertices of an *individual* NFP — build the exact feasible region
  // (IFP_rect − dilate(union(NFP_i), kerf)) and take its vertices. Those include the two-contact
  // interlocking seats that are vertices of the union but of no single NFP, which the anchor
  // enumeration provably cannot generate. Candidates are exact touching/kerf seats, so this path
  // also skips the bottom-left slide. Falls back to the legacy anchors if the union degenerates
  // to an empty feasible region (robustness guardrail, matching the rest of the epic).
  // Legacy anchor enumeration: bbox corners + interior-gap + concavity + per-pair NFP anchors.
  for (const cp of cache.items) {
    for (const pos of candidateAnchors(cp, partBB, kerf)) positions.push(pos);
    // Concavity anchors only matter under exact collision (bbox approximation rejects
    // them anyway), so skip them during the fast GA search.
    if (exact) for (const pos of concavityAnchors(cp, partBB)) positions.push(pos);
    if (nfpCtx) {
      const nfp = nfpFor(nfpCtx, cp);
      if (nfp)
        for (const pos of nfpCandidateAnchors(nfp, cp.bb.minX, cp.bb.minY, kerf))
          positions.push(pos);
    }
  }

  // NFP-union feasible-region path (P0, #26): AUGMENT the anchors with the vertices of the exact
  // feasible region (IFP_rect − dilate(union(NFP_i), kerf)). Those include the two-contact
  // interlocking seats that are vertices of the union but of no single NFP, which the per-pair
  // anchor enumeration provably cannot generate. Superset of candidates ⇒ density can only
  // improve under the same scoring; the slide still runs to settle them.
  if (nfpCtx) {
    const forbidden: ForbiddenNfp[] = [];
    for (const cp of cache.items) {
      const nfp = nfpFor(nfpCtx, cp);
      // The locus of moving-part reference positions that touch cp is NFP + cp's world origin.
      // The kerf dilation is cached per pair (key = placed-sig | moving-sig) — translation
      // happens inside feasibleVertices, so the dilated path amortizes across placements.
      if (nfp)
        forbidden.push({
          nfp,
          offx: cp.bb.minX,
          offy: cp.bb.minY,
          key: cp.sig + '|' + nfpCtx.movingSig,
        });
    }
    const ifp: IfpRect = {
      x0: 0,
      y0: 0,
      x1: sheet.width - partBB.width,
      y1: sheet.height - partBB.height,
    };
    for (const v of feasibleVertices(forbidden, ifp, kerf, nfpCtx.cache.dilated)) positions.push(v);
  }

  // Keep only in-sheet positions. Without NFP, prefer the lowest (bottom-left) — exactly
  // the legacy behavior. With NFP (P4), prefer the most COMPACT (smallest enclosing
  // bbox), bottom-left as tiebreak, so a part actually chosen seats into a pocket rather
  // than spreading along the bottom edge.
  const inSheet: ScoredPosition[] = [];
  for (const p of positions) {
    if (
      p.x < 0 ||
      p.y < 0 ||
      p.x + partBB.width > sheet.width ||
      p.y + partBB.height > sheet.height
    )
      continue;
    inSheet.push({
      x: p.x,
      y: p.y,
      strip: nfpCtx ? resultingStrip(union, p.y, partBB.height) : 0,
      bl: bl(p.x, p.y),
    });
  }

  const better = (a: ScoredPosition, b: ScoredPosition) =>
    nfpCtx ? a.strip - b.strip || a.bl - b.bl : a.bl - b.bl;
  // Partial-sort (#42): heapify in O(N) and extract the few candidates the budget consumes in
  // `better`-order, instead of fully sorting every in-sheet candidate up front.
  const heap = createPositionHeap(inSheet, (a, b) => better(a, b) < 0);

  // The NFP path validates a larger budget — the exact phase is short, and the compact
  // seat must not be missed just because lower-y exterior candidates fill the budget.
  const VALIDATE_BUDGET = nfpCtx ? 80 : 40;
  const SLIDE_BUDGET = nfpCtx ? 12 : 6;

  let best: ScoredPosition | null = null;
  let validated = 0;
  let slid = 0;
  while (heap.size > 0) {
    if (validated >= VALIDATE_BUDGET) break;
    const pos = heap.pop();
    if (hasCollision(normalizedPoly, pos.x, pos.y, cache, sheet, kerf, exact, nfpCtx)) continue;
    validated++;
    let cand = pos;
    // Slide only the first few collision-free candidates toward the origin.
    if (slid < SLIDE_BUDGET) {
      slid++;
      const s = slideBottomLeft(
        normalizedPoly,
        pos.x,
        pos.y,
        partBB,
        cache,
        sheet,
        kerf,
        exact,
        nfpCtx,
      );
      cand = {
        x: s.x,
        y: s.y,
        strip: nfpCtx ? resultingStrip(union, s.y, partBB.height) : 0,
        bl: bl(s.x, s.y),
      };
    }
    if (!best || better(cand, best) < 0) best = cand;
  }

  // Diagnostic (#26): did the validate cap stop us with candidates still unexamined? If so,
  // the genuinely tightest seat may have been truncated away before validation.
  recordBudgetOutcome(validated >= VALIDATE_BUDGET && heap.size > 0, !!nfpCtx);

  return best ? { position: { x: best.x, y: best.y }, hole: null } : null;
}

function tryGridFallback(
  normalizedPoly: Polygon,
  partBB: { width: number; height: number },
  cache: PlacedIndex,
  sheet: MaterialSheet,
  kerf: number,
  exact: boolean,
  nfpCtx?: NfpCtx,
): PlacementResult | null {
  const maxX = sheet.width - partBB.width;
  const maxY = sheet.height - partBB.height;
  // Density path: a fine grid finds tight interior pockets the coarse part-sized step skips
  // (e.g. a panel that only seats deep in a side gap). Bottom-up, left-to-right keeps the
  // bottom-left preference. Cost is bounded and only paid when the cheap anchor phases fail.
  const step = nfpCtx
    ? Math.max(8, Math.min(partBB.width, partBB.height) / 4)
    : Math.max(partBB.width, partBB.height, 10);

  for (let y = 0; y <= maxY; y += step) {
    for (let x = 0; x <= maxX; x += step) {
      if (!hasCollision(normalizedPoly, x, y, cache, sheet, kerf, exact, nfpCtx)) {
        return { position: { x, y }, hole: null };
      }
    }
  }

  return null;
}

function findBestPosition(
  normalizedPoly: Polygon,
  partBB: { width: number; height: number },
  cache: PlacedIndex,
  holes: CachedHole[],
  sheet: MaterialSheet,
  kerf: number,
  exact: boolean,
  nfpCtx?: NfpCtx,
): PlacementResult | null {
  // Phase 0: Try placing inside holes (always preferred — doesn't increase strip height)
  const holeResult = tryHolePlacement(normalizedPoly, partBB, holes, kerf, exact);
  if (holeResult) return holeResult;

  // Phase 1: Try origin first (common fast path for first part)
  if (!hasCollision(normalizedPoly, 0, 0, cache, sheet, kerf, exact, nfpCtx)) {
    return { position: { x: 0, y: 0 }, hole: null };
  }

  // Phase 2: Try positions adjacent to already-placed parts
  const adjacentResult = tryAdjacentPositions(
    normalizedPoly,
    partBB,
    cache,
    sheet,
    kerf,
    exact,
    nfpCtx,
  );
  if (adjacentResult) return adjacentResult;

  // Phase 3: Fallback coarse grid scan
  return tryGridFallback(normalizedPoly, partBB, cache, sheet, kerf, exact, nfpCtx);
}

// --- Collision detection ---

/** Check if a translated polygon overlaps any placement in a list (shared by hole and sheet collision). */
function checkOverlap(
  translatedPoly: Polygon,
  translatedBB: BoundingBox,
  placements: CachedPlacement[],
  kerf: number,
  exact: boolean,
  nfpCtx?: NfpCtx,
): boolean {
  for (const cp of placements) {
    if (
      translatedBB.maxX + kerf <= cp.bb.minX ||
      translatedBB.minX >= cp.bb.maxX + kerf ||
      translatedBB.maxY + kerf <= cp.bb.minY ||
      translatedBB.minY >= cp.bb.maxY + kerf
    ) {
      continue;
    }

    // NFP-clearance collision (#24, P5): one point-in-polygon + point-to-boundary test
    // against the cached per-pair NFP replaces the O(edgesA·edgesB) true-shape test, and
    // expresses kerf spacing as a clearance threshold. Falls back to the true-shape test
    // when the orbit failed to build for this pair (cache returned null).
    if (nfpCtx) {
      const nfp = nfpFor(nfpCtx, cp);
      if (nfp) {
        const tx = translatedBB.minX - cp.bb.minX;
        const ty = translatedBB.minY - cp.bb.minY;
        if (nfpClearance({ x: tx, y: ty }, nfp) < kerf - NFP_EPS) return true;
        continue;
      }
    }

    // kerf > 0, exact: true-shape spacing — parts may approach until their actual outlines
    // are `kerf` apart (#11). kerf > 0, not exact: fast bounding-box approximation (any
    // bbox overlap within kerf is a collision) — used during GA search; the final
    // committed placement is re-run exact (#19). kerf == 0: exact polygon interpenetration
    // (concave-correct; touching is allowed so common-line parts may abut).
    if (kerf > 0) {
      if (!exact) return true; // fast bbox approximation
      if (polygonsCloserThan(translatedPoly, cp.polygon, kerf)) return true;
      continue;
    }

    if (polygonsInterpenetrate(translatedPoly, cp.polygon)) {
      return true;
    }
  }

  return false;
}

function hasCollision(
  poly: Polygon,
  x: number,
  y: number,
  cache: PlacedIndex,
  sheet: MaterialSheet,
  kerf: number,
  exact: boolean,
  nfpCtx?: NfpCtx,
): boolean {
  const translated = translatePolygon(poly, x, y);
  const bb = boundingBox(translated);

  if (bb.minX < 0 || bb.minY < 0 || bb.maxX > sheet.width || bb.maxY > sheet.height) {
    return true;
  }

  // Spatial-index query (#42): test only placements whose cells meet the kerf-expanded query
  // box. checkOverlap re-applies the exact bbox-reject to each, so the result is identical to
  // scanning every placement — every placement the grid omits would fail that bbox test anyway.
  const candidates = cache.query(bb, kerf);
  return checkOverlap(translated, bb, candidates, kerf, exact, nfpCtx);
}
