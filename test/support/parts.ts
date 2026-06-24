/**
 * Shared part factories for tests.
 *
 * The axis-aligned rectangle `[[0,0],[w,0],[w,h],[0,h]]` was the most-copied test
 * fixture in the suite (a `makePart`/`rect` definition in nine files). `makeRect`
 * is the single source; the `extra` bag sets optional `Part` fields (priority,
 * grainConstraint, lockOrientation, …) without re-declaring the polygon literal.
 */
import type { Part, PlacedPart } from '$lib/geometry/types';

/** A unit-rectangle part at the origin. `extra` overrides any `Part` field. */
export function makeRect(id: string, w: number, h: number, extra: Partial<Part> = {}): Part {
  return {
    id,
    name: id,
    polygons: [
      [
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: h },
        { x: 0, y: h },
      ],
    ],
    sourceIndex: 0,
    ...extra,
  };
}

/** A placed rectangle part — for exporter tests that need a positioned PlacedPart. */
export function makePlaced(
  id: string,
  w: number,
  h: number,
  x: number,
  y: number,
  rotation = 0,
): PlacedPart {
  return { part: makeRect(id, w, h), x, y, rotation };
}
