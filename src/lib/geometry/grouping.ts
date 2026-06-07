import type { Part, Polygon, BoundingBox } from './types';
import { boundingBox, polygonArea } from './polygon';
import { polygonContainsPolygon } from '$lib/nesting/nfp';

/**
 * Grid size (mm) for treating two vertices as the same point. Coincident
 * duplicate paths share exact source coordinates, so this only needs to absorb
 * floating-point noise.
 */
const COINCIDENT_TOL = 1e-2;

/**
 * Position-aware signature of a polygon: a sorted, quantized vertex multiset.
 * Independent of winding direction and starting vertex.
 */
function polygonSignature(poly: Polygon): string {
  const q = 1 / COINCIDENT_TOL;
  return poly
    .map((p) => `${Math.round(p.x * q)},${Math.round(p.y * q)}`)
    .sort()
    .join(';');
}

function partSignature(part: Part): string {
  return part.polygons.map(polygonSignature).sort().join('|');
}

/**
 * Remove parts whose geometry exactly overlaps an earlier part at the same
 * position (LightBurn "duplicate / overlapping lines"). Unlike
 * `deduplicateParts`, this is position-aware: identical shapes at *different*
 * positions are kept (they are genuinely separate parts). The first occurrence
 * of each coincident shape is kept.
 */
export function removeCoincidentDuplicates(parts: Part[]): Part[] {
  const seen = new Set<string>();
  const result: Part[] = [];
  for (const part of parts) {
    const sig = partSignature(part);
    if (seen.has(sig)) continue;
    seen.add(sig);
    result.push(part);
  }
  return result;
}

interface PolyNode {
  poly: Polygon;
  area: number;
  bb: BoundingBox;
  part: Part; // the part this polygon came from (for id/name when it's an outer)
  parent: number; // index of the smallest polygon that contains this one, or -1
  depth: number; // 0 = outer, 1 = cutout, 2 = island, ...
}

/**
 * Group parts by geometric containment so that a shape fully enclosed by
 * another becomes an interior cutout of it, instead of an independent part.
 *
 * Parsers emit each shape as its own single-polygon part (and SVG paths may
 * already carry sub-polygons). This collapses that flat list into parts whose
 * `polygons` array is `[outerBoundary, ...cutouts]`, matching how the nesting
 * engine, renderer, and exporters interpret a part.
 *
 * Containment nests: a solid "island" inside a hole becomes its own part again
 * (even depth = solid boundary, odd depth = cutout of the nearest solid).
 */
export function groupByContainment(parts: Part[]): Part[] {
  const nodes: PolyNode[] = [];
  for (const part of parts) {
    for (const poly of part.polygons) {
      if (poly.length < 3) continue;
      nodes.push({
        poly,
        area: polygonArea(poly),
        bb: boundingBox(poly),
        part,
        parent: -1,
        depth: 0,
      });
    }
  }

  // For each polygon, find the smallest-area polygon that strictly contains it.
  for (let i = 0; i < nodes.length; i++) {
    let bestParent = -1;
    let bestArea = Infinity;
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const outer = nodes[j];
      const inner = nodes[i];
      if (outer.area <= inner.area) continue; // a container must be larger
      if (!bbContains(outer.bb, inner.bb)) continue; // cheap reject
      if (!polygonContainsPolygon(outer.poly, inner.poly)) continue;
      if (outer.area < bestArea) {
        bestArea = outer.area;
        bestParent = j;
      }
    }
    nodes[i].parent = bestParent;
  }

  // Depth = number of ancestors. Even depth => solid (its own part).
  for (const node of nodes) {
    let depth = 0;
    let p = node.parent;
    while (p !== -1) {
      depth++;
      p = nodes[p].parent;
    }
    node.depth = depth;
  }

  // Build parts: each even-depth node is an outer boundary; its odd-depth
  // direct children are its cutouts.
  const result: Part[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.depth % 2 !== 0) continue; // cutouts are consumed by their parent

    const cutouts = nodes.filter((n) => n.parent === i).map((n) => n.poly);
    result.push({
      id: node.part.id,
      name: node.part.name,
      sourceIndex: node.part.sourceIndex,
      polygons: [node.poly, ...cutouts],
    });
  }

  return result;
}

function bbContains(outer: BoundingBox, inner: BoundingBox): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.minY >= outer.minY &&
    inner.maxX <= outer.maxX &&
    inner.maxY <= outer.maxY
  );
}
