import type { Point, Polygon, Part, PlacedPart, MaterialSheet } from '$lib/geometry/types';
import {
  boundingBox,
  rotatePolygon,
  translatePolygon,
  transformPartPolygons,
} from '$lib/geometry/polygon';
import type { BoundingBox } from '$lib/geometry/types';
import {
  polygonsOverlap,
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
  parts: { part: Part; rotation: number }[],
  sheet: MaterialSheet,
  kerf: number = 0,
): PlacedPart[] {
  const placed: PlacedPart[] = [];
  const cache: CachedPlacement[] = [];
  let holes: CachedHole[] = [];

  for (const { part, rotation } of parts) {
    const outerPoly = part.polygons[0];
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
    );
    if (result) {
      const pp: PlacedPart = { part, x: result.position.x, y: result.position.y, rotation };
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
        const newHoles = extractHoles(part, rotation, result.position, cache.length - 1, kerf);
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
): CachedHole[] {
  if (part.polygons.length <= 1) return [];

  // Transform the whole part as a rigid body so holes keep their position
  // relative to the outer boundary (index 0 = outer boundary, 1.. = holes).
  const placedPolys = transformPartPolygons(part.polygons, rotation, position.x, position.y);
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
      if (checkOverlap(translated, translatedBB, hole.innerPlacements, kerf)) continue;

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
): Point {
  const step = Math.max(1, Math.min(partBB.width, partBB.height) / 4);
  // Bound iterations to what the sheet can physically accommodate (never more than the
  // sheet's longest side / step), so the cap stays tight regardless of sheet size.
  const MAX_STEPS = Math.ceil(Math.max(sheet.width, sheet.height) / step) + 1;

  let cx = x;
  let cy = y;

  let i = 0;
  while (i++ < MAX_STEPS && !hasCollision(poly, cx, cy - step, cache, sheet, kerf)) {
    cy -= step;
  }
  i = 0;
  while (i++ < MAX_STEPS && !hasCollision(poly, cx - step, cy, cache, sheet, kerf)) {
    cx -= step;
  }

  return { x: cx, y: cy };
}

function tryAdjacentPositions(
  normalizedPoly: Polygon,
  partBB: { width: number; height: number },
  cache: CachedPlacement[],
  sheet: MaterialSheet,
  kerf: number,
): PlacementResult | null {
  const candidates: { x: number; y: number; score: number }[] = [];

  for (const cp of cache) {
    for (const pos of candidateAnchors(cp, partBB, kerf)) {
      if (
        pos.x >= 0 &&
        pos.y >= 0 &&
        pos.x + partBB.width <= sheet.width &&
        pos.y + partBB.height <= sheet.height &&
        !hasCollision(normalizedPoly, pos.x, pos.y, cache, sheet, kerf)
      ) {
        // Pull the candidate toward the origin so it settles into any open gap
        // beneath/left of it that does not raise the strip height.
        const slid = slideBottomLeft(normalizedPoly, pos.x, pos.y, partBB, cache, sheet, kerf);
        candidates.push({ ...slid, score: slid.y * sheet.width + slid.x });
      }
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.score - b.score);
  return { position: { x: candidates[0].x, y: candidates[0].y }, hole: null };
}

function tryGridFallback(
  normalizedPoly: Polygon,
  partBB: { width: number; height: number },
  cache: CachedPlacement[],
  sheet: MaterialSheet,
  kerf: number,
): PlacementResult | null {
  const maxX = sheet.width - partBB.width;
  const maxY = sheet.height - partBB.height;
  const step = Math.max(partBB.width, partBB.height, 10);

  for (let y = 0; y <= maxY; y += step) {
    for (let x = 0; x <= maxX; x += step) {
      if (!hasCollision(normalizedPoly, x, y, cache, sheet, kerf)) {
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
): PlacementResult | null {
  // Phase 0: Try placing inside holes (always preferred — doesn't increase strip height)
  const holeResult = tryHolePlacement(normalizedPoly, partBB, holes, kerf);
  if (holeResult) return holeResult;

  // Phase 1: Try origin first (common fast path for first part)
  if (!hasCollision(normalizedPoly, 0, 0, cache, sheet, kerf)) {
    return { position: { x: 0, y: 0 }, hole: null };
  }

  // Phase 2: Try positions adjacent to already-placed parts
  const adjacentResult = tryAdjacentPositions(normalizedPoly, partBB, cache, sheet, kerf);
  if (adjacentResult) return adjacentResult;

  // Phase 3: Fallback coarse grid scan
  return tryGridFallback(normalizedPoly, partBB, cache, sheet, kerf);
}

// --- Collision detection ---

/** Check if a translated polygon overlaps any placement in a list (shared by hole and sheet collision). */
function checkOverlap(
  translatedPoly: Polygon,
  translatedBB: BoundingBox,
  placements: CachedPlacement[],
  kerf: number,
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

    // When kerf > 0, bounding-box overlap (with kerf margin) is treated as collision.
    // This is an intentional approximation: exact polygon overlap checking with kerf
    // would require offsetting polygons, which is expensive. The tradeoff is slightly
    // less dense packing when kerf is non-zero, but much faster placement.
    if (kerf > 0) return true;

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
): boolean {
  const translated = translatePolygon(poly, x, y);
  const bb = boundingBox(translated);

  if (bb.minX < 0 || bb.minY < 0 || bb.maxX > sheet.width || bb.maxY > sheet.height) {
    return true;
  }

  return checkOverlap(translated, bb, cache, kerf);
}
