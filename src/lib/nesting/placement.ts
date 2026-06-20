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
  polygonsOverlap,
  polygonsCloserThan,
  reflexVertices,
  insetPolygon as computeInsetPolygon,
  polygonContainsPolygon,
  pointInPolygon,
} from './nfp';
import type { NfpCache } from './nfp-cache';

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
  const cache: CachedPlacement[] = [];
  let holes: CachedHole[] = [];
  const useNfp = exact && nfpCache != null;

  for (const { part, rotation, mirror } of parts) {
    const outerPoly = mirror ? reflectPolygon(part.polygons[0]) : part.polygons[0];
    const rotated = rotatePolygon(outerPoly, rotation);
    const bb = boundingBox(rotated);
    const normalized = translatePolygon(rotated, -bb.minX, -bb.minY);
    const partW = bb.width;
    const partH = bb.height;

    if (partW > sheet.width || partH > sheet.height) {
      continue;
    }

    const sig = useNfp ? polySignature(normalized) : '';
    const nfpCtx: NfpCtx | undefined =
      useNfp && nfpCache ? { cache: nfpCache, movingSig: sig, movingPoly: normalized } : undefined;

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
    if (result) {
      const pp: PlacedPart = { part, x: result.position.x, y: result.position.y, rotation, mirror };
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
      cache.push(cp);

      if (result.hole) {
        result.hole.innerPlacements.push(cp);
      } else {
        // Only extract holes from parts placed on the sheet (no recursive nesting)
        const newHoles = extractHoles(
          part,
          rotation,
          result.position,
          cache.length - 1,
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
  cache: CachedPlacement[],
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
  cache: CachedPlacement[],
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
  const union = nfpCtx ? placedUnionBB(cache) : null;
  const positions: { x: number; y: number }[] = [];
  for (const cp of cache) {
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
  inSheet.sort(better);

  // The NFP path validates a larger budget — the exact phase is short, and the compact
  // seat must not be missed just because lower-y exterior candidates fill the budget.
  const VALIDATE_BUDGET = nfpCtx ? 80 : 40;
  const SLIDE_BUDGET = nfpCtx ? 12 : 6;

  let best: ScoredPosition | null = null;
  let validated = 0;
  let slid = 0;
  for (const pos of inSheet) {
    if (validated >= VALIDATE_BUDGET) break;
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

  return best ? { position: { x: best.x, y: best.y }, hole: null } : null;
}

function tryGridFallback(
  normalizedPoly: Polygon,
  partBB: { width: number; height: number },
  cache: CachedPlacement[],
  sheet: MaterialSheet,
  kerf: number,
  exact: boolean,
  nfpCtx?: NfpCtx,
): PlacementResult | null {
  const maxX = sheet.width - partBB.width;
  const maxY = sheet.height - partBB.height;
  const step = Math.max(partBB.width, partBB.height, 10);

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
  cache: CachedPlacement[],
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
    // committed placement is re-run exact (#19). kerf == 0: exact polygon overlap.
    if (kerf > 0) {
      if (!exact) return true; // fast bbox approximation
      if (polygonsCloserThan(translatedPoly, cp.polygon, kerf)) return true;
      continue;
    }

    if (polygonsOverlap(translatedPoly, cp.polygon)) {
      return true;
    }
  }

  return false;
}

function hasCollision(
  poly: Polygon,
  x: number,
  y: number,
  cache: CachedPlacement[],
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

  return checkOverlap(translated, bb, cache, kerf, exact, nfpCtx);
}
