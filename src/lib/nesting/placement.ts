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
} from './nfp';

interface CachedPlacement {
  pp: PlacedPart;
  polygon: Polygon;
  bb: BoundingBox;
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

export function bottomLeftFill(
  parts: { part: Part; rotation: number; mirror?: boolean }[],
  sheet: MaterialSheet,
  kerf: number = 0,
  exact: boolean = true,
): PlacedPart[] {
  const placed: PlacedPart[] = [];
  const cache: CachedPlacement[] = [];
  let holes: CachedHole[] = [];

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

    const result = findBestPosition(
      normalized,
      { width: partW, height: partH },
      cache,
      holes,
      sheet,
      kerf,
      exact,
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
      const cp: CachedPlacement = { pp, polygon: finalPoly, bb: finalBB };
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
    while (i++ < MAX_STEPS && !hasCollision(poly, cx, cy - step, cache, sheet, kerf, exact)) {
      cy -= step;
    }
    i = 0;
    while (i++ < MAX_STEPS && !hasCollision(poly, cx - step, cy, cache, sheet, kerf, exact)) {
      cx -= step;
    }
    if (cx === prevX && cy === prevY) break; // converged
  }

  return { x: cx, y: cy };
}

function tryAdjacentPositions(
  normalizedPoly: Polygon,
  partBB: { width: number; height: number },
  cache: CachedPlacement[],
  sheet: MaterialSheet,
  kerf: number,
  exact: boolean,
): PlacementResult | null {
  // Generate candidate positions (cheap): bbox corners + interior-gap anchors (gap-fill)
  // + concavity anchors (#12 — seat the part's corners at placed parts' reflex/notch
  // vertices so it can tuck into concavities). Validation is expensive (true-shape kerf
  // collision), so we cap how many positions we validate and slide rather than checking
  // every one. Concavity generation is an NFP-flavored candidate set; exact collision
  // and the slide reject/settle them.
  const score = (x: number, y: number) => y * sheet.width + x;
  const positions: { x: number; y: number; score: number }[] = [];
  for (const cp of cache) {
    for (const pos of candidateAnchors(cp, partBB, kerf))
      positions.push({ ...pos, score: score(pos.x, pos.y) });
    // Concavity anchors only matter under exact collision (bbox approximation rejects
    // them anyway), so skip them during the fast GA search.
    if (exact)
      for (const pos of concavityAnchors(cp, partBB))
        positions.push({ ...pos, score: score(pos.x, pos.y) });
  }

  // Keep only in-sheet positions, prefer the lowest (bottom-left), and validate at most
  // VALIDATE_BUDGET of them with the expensive collision check — bounds cost regardless
  // of how many notches the placed parts have.
  const VALIDATE_BUDGET = 40;
  const SLIDE_BUDGET = 6;
  const inSheet = positions.filter(
    (p) =>
      p.x >= 0 &&
      p.y >= 0 &&
      p.x + partBB.width <= sheet.width &&
      p.y + partBB.height <= sheet.height,
  );
  inSheet.sort((a, b) => a.score - b.score);

  let best: { x: number; y: number; score: number } | null = null;
  let validated = 0;
  let slid = 0;
  for (const pos of inSheet) {
    if (validated >= VALIDATE_BUDGET) break;
    if (hasCollision(normalizedPoly, pos.x, pos.y, cache, sheet, kerf, exact)) continue;
    validated++;
    // Slide only the first few collision-free candidates toward the origin.
    if (slid < SLIDE_BUDGET) {
      slid++;
      const s = slideBottomLeft(normalizedPoly, pos.x, pos.y, partBB, cache, sheet, kerf, exact);
      const sc = score(s.x, s.y);
      if (!best || sc < best.score) best = { x: s.x, y: s.y, score: sc };
    } else if (!best || pos.score < best.score) {
      best = pos;
    }
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
): PlacementResult | null {
  const maxX = sheet.width - partBB.width;
  const maxY = sheet.height - partBB.height;
  const step = Math.max(partBB.width, partBB.height, 10);

  for (let y = 0; y <= maxY; y += step) {
    for (let x = 0; x <= maxX; x += step) {
      if (!hasCollision(normalizedPoly, x, y, cache, sheet, kerf, exact)) {
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
): PlacementResult | null {
  // Phase 0: Try placing inside holes (always preferred — doesn't increase strip height)
  const holeResult = tryHolePlacement(normalizedPoly, partBB, holes, kerf, exact);
  if (holeResult) return holeResult;

  // Phase 1: Try origin first (common fast path for first part)
  if (!hasCollision(normalizedPoly, 0, 0, cache, sheet, kerf, exact)) {
    return { position: { x: 0, y: 0 }, hole: null };
  }

  // Phase 2: Try positions adjacent to already-placed parts
  const adjacentResult = tryAdjacentPositions(normalizedPoly, partBB, cache, sheet, kerf, exact);
  if (adjacentResult) return adjacentResult;

  // Phase 3: Fallback coarse grid scan
  return tryGridFallback(normalizedPoly, partBB, cache, sheet, kerf, exact);
}

// --- Collision detection ---

/** Check if a translated polygon overlaps any placement in a list (shared by hole and sheet collision). */
function checkOverlap(
  translatedPoly: Polygon,
  translatedBB: BoundingBox,
  placements: CachedPlacement[],
  kerf: number,
  exact: boolean,
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
): boolean {
  const translated = translatePolygon(poly, x, y);
  const bb = boundingBox(translated);

  if (bb.minX < 0 || bb.minY < 0 || bb.maxX > sheet.width || bb.maxY > sheet.height) {
    return true;
  }

  return checkOverlap(translated, bb, cache, kerf, exact);
}
