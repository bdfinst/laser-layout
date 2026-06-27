import type { Point, Polygon, Part } from '$lib/geometry/types';
import {
  type AffineMatrix,
  IDENTITY,
  multiplyMatrices,
  applyMatrixToPolygon,
  cubicBezier,
} from '$lib/geometry/affine';
import { dropClosingVertex } from '$lib/geometry/polygon';
import { CURVE_SEGMENTS, CIRCLE_SEGMENTS, MAX_DEPTH, MAX_FILE_SIZE } from './constants';
import { pushPart } from './part-builder';

function parseXForm(el: Element): AffineMatrix {
  const xformEl = el.querySelector(':scope > XForm');
  if (!xformEl?.textContent) return IDENTITY;
  const nums = xformEl.textContent.trim().split(/\s+/).map(Number);
  if (nums.length < 6) return IDENTITY;
  return { a: nums[0], b: nums[1], c: nums[2], d: nums[3], e: nums[4], f: nums[5] };
}

interface Vertex {
  x: number;
  y: number;
  c0x?: number;
  c0y?: number;
  c1x?: number;
  c1y?: number;
}

function parseVertList(text: string): Vertex[] {
  const verts: Vertex[] = [];
  const vertRegex =
    /V([-\d.eE+]+)\s+([-\d.eE+]+)(?:c0x([-\d.eE+]+)c0y([-\d.eE+]+)c1x([-\d.eE+]+)c1y([-\d.eE+]+))?/g;
  let match;
  while ((match = vertRegex.exec(text)) !== null) {
    const v: Vertex = { x: parseFloat(match[1]), y: parseFloat(match[2]) };
    if (match[3] !== undefined) {
      v.c0x = parseFloat(match[3]);
      v.c0y = parseFloat(match[4]);
      v.c1x = parseFloat(match[5]);
      v.c1y = parseFloat(match[6]);
    }
    verts.push(v);
  }
  return verts;
}

interface Primitive {
  type: 'B' | 'L';
  from: number;
  to: number;
}

function parsePrimList(text: string): Primitive[] {
  const prims: Primitive[] = [];
  const primRegex = /([BL])(\d+)\s+(\d+)/g;
  let match;
  while ((match = primRegex.exec(text)) !== null) {
    prims.push({ type: match[1] as 'B' | 'L', from: parseInt(match[2]), to: parseInt(match[3]) });
  }
  return prims;
}

function buildPolygonFromPrimitives(verts: Vertex[], prims: Primitive[]): Polygon {
  if (prims.length === 0 || verts.length === 0) return [];

  const points: Point[] = [];
  // Primitive indices come from untrusted file text — an out-of-range `from`/`to` would
  // dereference `undefined` and throw. Guard every lookup and skip bad references.
  const firstVert = verts[prims[0].from];
  if (!firstVert) return [];
  points.push({ x: firstVert.x, y: firstVert.y });

  for (const prim of prims) {
    const fromVert = verts[prim.from];
    const toVert = verts[prim.to];
    if (!fromVert || !toVert) continue;

    if (prim.type === 'L') {
      points.push({ x: toVert.x, y: toVert.y });
    } else {
      const p0: Point = { x: fromVert.x, y: fromVert.y };
      const p1: Point = { x: fromVert.c0x ?? fromVert.x, y: fromVert.c0y ?? fromVert.y };
      const p2: Point = { x: toVert.c1x ?? toVert.x, y: toVert.c1y ?? toVert.y };
      const p3: Point = { x: toVert.x, y: toVert.y };
      points.push(...cubicBezier(p0, p1, p2, p3, CURVE_SEGMENTS));
    }
  }

  return dropClosingVertex(points);
}

/**
 * Build a polygon from a vertex list and the raw PrimList text.
 *
 * LightBurn writes explicit `L`/`B` index primitives for most paths, but for
 * simple closed polylines it emits the shorthand `LineClosed` (or `Line`),
 * which means "connect every vertex in order". Without handling this, such
 * shapes parse to zero primitives and get silently dropped.
 */
function buildPolygon(verts: Vertex[], primText: string): Polygon {
  const trimmed = primText.trim();
  if (trimmed === '' || verts.length === 0) return [];

  // 'LineClosed' / 'Line': straight segments through every vertex in order.
  if (/^Line/i.test(trimmed)) {
    const points: Point[] = verts.map((v) => ({ x: v.x, y: v.y }));
    return dropClosingVertex(points);
  }

  return buildPolygonFromPrimitives(verts, parsePrimList(trimmed));
}

/** Shared vertex/primitive pool — LightBurn stores geometry in shared pools referenced by ID */
interface GeometryPool {
  verts: Map<string, Vertex[]>;
  primText: Map<string, string>;
}

/** Scan the entire document for all VertList/PrimList data, indexed by VertID/PrimID */
function buildGeometryPool(root: Element): GeometryPool {
  const verts = new Map<string, Vertex[]>();
  const primText = new Map<string, string>();

  const shapes = root.querySelectorAll('Shape[Type="Path"]');
  for (const shape of Array.from(shapes)) {
    const vertId = shape.getAttribute('VertID');
    const primId = shape.getAttribute('PrimID');

    const vertListEl = shape.querySelector(':scope > VertList');
    const primListEl = shape.querySelector(':scope > PrimList');

    if (vertId && vertListEl?.textContent) {
      // Only store the first definition (don't overwrite with empty)
      if (!verts.has(vertId)) {
        verts.set(vertId, parseVertList(vertListEl.textContent));
      }
    }

    // Store the raw PrimList text; it may be index primitives or the
    // 'LineClosed' shorthand, both resolved per-shape against its own verts.
    if (primId && primListEl?.textContent) {
      if (!primText.has(primId)) {
        primText.set(primId, primListEl.textContent);
      }
    }
  }

  return { verts, primText };
}

/** Geometry tolerance for treating two segment endpoints as the same point (mm). */
const STITCH_TOL = 1e-3;

/** Why a shape produced no usable polygon — one bucket per import diagnostic. */
const SKIP_REASONS = ['open-path', 'empty-primlist', 'unresolved-id', 'filtered-layer'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/**
 * The single per-shape "what happened to this shape" decision, so the
 * polygon-assembly path and the layer-filter path feed one diagnostics channel.
 * - `part`: a usable closed polygon (>= 3 points).
 * - `open`: a sub-3-point open polyline (world-space) that may stitch into a
 *   contour with its neighbours before being accepted or reported.
 * - `skip`: nothing usable, with the reason it was dropped.
 */
type ShapeOutcome =
  | { kind: 'part'; typeName: string; polygons: Polygon[] }
  | { kind: 'open'; polyline: Polygon }
  | { kind: 'skip'; reason: SkipReason };

function pointsCoincide(a: Point, b: Point, eps: number): boolean {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;
}

/**
 * Join open polyline segments that share endpoints (within `eps`) into longer
 * chains. A box generator emits its outline as many disconnected 2-point
 * segments; each is below the >= 3 threshold on its own, but stitched together
 * they form one closed contour. Chains that reach >= 3 points (after dropping a
 * closing duplicate) are returned as `contours`; anything that stays degenerate
 * is returned as `leftover` for diagnostics.
 */
function stitchOpenSegments(
  segments: Polygon[],
  eps: number,
): {
  contours: Polygon[];
  leftover: Polygon[];
} {
  const remaining = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  const chains: Point[][] = [];

  while (remaining.length > 0) {
    let chain = remaining.shift() as Point[];
    let extended = true;
    while (extended) {
      extended = false;
      for (let i = 0; i < remaining.length; i++) {
        const seg = remaining[i];
        const head = chain[0];
        const tail = chain[chain.length - 1];
        const segStart = seg[0];
        const segEnd = seg[seg.length - 1];

        if (pointsCoincide(tail, segStart, eps)) {
          chain = chain.concat(seg.slice(1));
        } else if (pointsCoincide(tail, segEnd, eps)) {
          chain = chain.concat(seg.slice(0, -1).reverse());
        } else if (pointsCoincide(head, segEnd, eps)) {
          chain = seg.slice(0, -1).concat(chain);
        } else if (pointsCoincide(head, segStart, eps)) {
          chain = seg.slice(1).reverse().concat(chain);
        } else {
          continue;
        }
        remaining.splice(i, 1);
        extended = true;
        break;
      }
    }
    chains.push(chain);
  }

  const contours: Polygon[] = [];
  const leftover: Polygon[] = [];
  for (const chain of chains) {
    const closed = dropClosingVertex(chain, eps);
    if (closed.length >= 3) contours.push(closed);
    else leftover.push(chain);
  }
  return { contours, leftover };
}

/** Resolve a Path shape's geometry into a part, an open segment, or a skip. */
function processPath(el: Element, matrix: AffineMatrix, pool: GeometryPool): ShapeOutcome {
  const vertId = el.getAttribute('VertID');
  const primId = el.getAttribute('PrimID');

  const vertListEl = el.querySelector(':scope > VertList');
  const primListEl = el.querySelector(':scope > PrimList');

  const hasInlineVerts = !!vertListEl?.textContent;
  const hasInlinePrims = !!primListEl?.textContent;

  const verts = hasInlineVerts
    ? parseVertList(vertListEl!.textContent!)
    : vertId
      ? (pool.verts.get(vertId) ?? [])
      : [];

  const primText = hasInlinePrims
    ? primListEl!.textContent!
    : primId
      ? (pool.primText.get(primId) ?? '')
      : '';

  const poly = buildPolygon(verts, primText);
  if (poly.length >= 3) {
    return { kind: 'part', typeName: 'Path', polygons: [applyMatrixToPolygon(matrix, poly)] };
  }
  if (poly.length >= 2) {
    return { kind: 'open', polyline: applyMatrixToPolygon(matrix, poly) };
  }

  const vertUnresolved = !!vertId && !hasInlineVerts && !pool.verts.has(vertId);
  const primUnresolved = !!primId && !hasInlinePrims && !pool.primText.has(primId);
  return {
    kind: 'skip',
    reason: vertUnresolved || primUnresolved ? 'unresolved-id' : 'empty-primlist',
  };
}

function processShape(
  el: Element,
  parentMatrix: AffineMatrix,
  depth: number,
  pool: GeometryPool,
): ShapeOutcome[] {
  if (depth > MAX_DEPTH) return [];

  const type = el.getAttribute('Type');
  if (!type) return [];

  const localXForm = parseXForm(el);
  const matrix = multiplyMatrices(parentMatrix, localXForm);

  if (type === 'Group') {
    const children = el.querySelector(':scope > Children');
    if (!children) return [];
    const outcomes: ShapeOutcome[] = [];
    for (const child of Array.from(children.children)) {
      if (child.tagName === 'Shape') {
        outcomes.push(...processShape(child, matrix, depth + 1, pool));
      }
    }
    return outcomes;
  }

  switch (type) {
    case 'Rect': {
      const w = parseFloat(el.getAttribute('W') ?? '0');
      const h = parseFloat(el.getAttribute('H') ?? '0');
      const raw: Polygon = [
        { x: -w / 2, y: -h / 2 },
        { x: w / 2, y: -h / 2 },
        { x: w / 2, y: h / 2 },
        { x: -w / 2, y: h / 2 },
      ];
      return [{ kind: 'part', typeName: 'Rect', polygons: [applyMatrixToPolygon(matrix, raw)] }];
    }
    case 'Ellipse': {
      const rx = parseFloat(el.getAttribute('Rx') ?? '0');
      const ry = parseFloat(el.getAttribute('Ry') ?? '0');
      const raw: Polygon = [];
      for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
        const angle = (2 * Math.PI * i) / CIRCLE_SEGMENTS;
        raw.push({ x: rx * Math.cos(angle), y: ry * Math.sin(angle) });
      }
      return [{ kind: 'part', typeName: 'Ellipse', polygons: [applyMatrixToPolygon(matrix, raw)] }];
    }
    case 'Path':
      return [processPath(el, matrix, pool)];
    default:
      return [];
  }
}

function getCutIndices(root: Element): Set<string> {
  const cutIndices = new Set<string>();
  for (const cs of Array.from(root.querySelectorAll('CutSetting'))) {
    const type = cs.getAttribute('type');
    if (type === 'Tool') continue;
    const indexEl = cs.querySelector('index');
    if (indexEl) {
      const val = indexEl.getAttribute('Value');
      if (val) cutIndices.add(val);
    }
  }
  return cutIndices;
}

/** Human-friendly label for each skip reason, used in user-facing summaries. */
const SKIP_LABELS: Record<SkipReason, string> = {
  'open-path': 'open paths',
  'empty-primlist': 'empty geometry',
  'unresolved-id': 'unresolved references',
  'filtered-layer': 'filtered layers',
};

/** Summary of what an import produced — how many parts, and what was dropped and why. */
export interface ImportDiagnostics {
  imported: number;
  skipped: number;
  skippedByReason: Record<SkipReason, number>;
}

function emptyReasonCounts(): Record<SkipReason, number> {
  const counts = {} as Record<SkipReason, number>;
  for (const reason of SKIP_REASONS) counts[reason] = 0;
  return counts;
}

/**
 * Render import diagnostics as a single human-readable line, or `null` when
 * nothing was skipped. e.g. `"12 shapes skipped: 8 open paths, 4 filtered layers"`.
 */
export function summarizeSkipped(diagnostics: ImportDiagnostics): string | null {
  if (diagnostics.skipped <= 0) return null;
  const reasons = SKIP_REASONS.filter((reason) => diagnostics.skippedByReason[reason] > 0).map(
    (reason) => `${diagnostics.skippedByReason[reason]} ${SKIP_LABELS[reason]}`,
  );
  const noun = diagnostics.skipped === 1 ? 'shape' : 'shapes';
  return `${diagnostics.skipped} ${noun} skipped: ${reasons.join(', ')}`;
}

/**
 * Parse a LightBurn document into parts plus an import-diagnostics summary.
 * `parseLightBurn` is the back-compatible `Part[]`-only wrapper around this.
 */
export function parseLightBurnWithDiagnostics(xmlString: string): {
  parts: Part[];
  diagnostics: ImportDiagnostics;
} {
  if (xmlString.length > MAX_FILE_SIZE) {
    throw new Error(
      `LightBurn file too large (${(xmlString.length / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.`,
    );
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'text/xml');
  const root = doc.documentElement;
  const parts: Part[] = [];
  const counter = { value: 0 };
  const skippedByReason = emptyReasonCounts();

  const cutIndices = getCutIndices(root);
  const pool = buildGeometryPool(root);
  const topShapes = Array.from(root.children).filter((c) => c.tagName === 'Shape');

  // A top-level shape is filtered out when its CutIndex is not in the allowed
  // set. Fail open: if filtering would exclude *every* shape (e.g. the only
  // geometry lives on a Tool-backed layer), import all shapes instead — layer
  // filtering must never reduce the result to zero parts.
  const wouldFilter = (shape: Element): boolean => {
    if (cutIndices.size === 0) return false;
    const cutIndex = shape.getAttribute('CutIndex');
    return cutIndex !== null && !cutIndices.has(cutIndex);
  };
  const applyFilter = !(topShapes.length > 0 && topShapes.every(wouldFilter));

  const openSegments: Polygon[] = [];
  for (const shape of topShapes) {
    if (applyFilter && wouldFilter(shape)) {
      skippedByReason['filtered-layer']++;
      continue;
    }
    for (const outcome of processShape(shape, IDENTITY, 0, pool)) {
      if (outcome.kind === 'part') {
        pushPart(parts, outcome.polygons, `${outcome.typeName}-${counter.value}`, counter);
      } else if (outcome.kind === 'open') {
        openSegments.push(outcome.polyline);
      } else {
        skippedByReason[outcome.reason]++;
      }
    }
  }

  const { contours, leftover } = stitchOpenSegments(openSegments, STITCH_TOL);
  for (const contour of contours) {
    pushPart(parts, [contour], `Path-${counter.value}`, counter);
  }
  skippedByReason['open-path'] += leftover.length;

  const skipped = SKIP_REASONS.reduce((sum, reason) => sum + skippedByReason[reason], 0);
  return { parts, diagnostics: { imported: parts.length, skipped, skippedByReason } };
}

export function parseLightBurn(xmlString: string): Part[] {
  return parseLightBurnWithDiagnostics(xmlString).parts;
}
