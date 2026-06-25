import type { Part, Polygon } from '$lib/geometry/types';

/**
 * Append a parsed shape as a `Part` and advance the shared counter.
 *
 * The SVG (`processElement`) and LightBurn (`processShape`) walkers each compute a
 * format-specific `name` and transformed `polygons`, then build the identical `Part` shape
 * (`id: part-N`, `sourceIndex: N`) and bump the counter. That common tail lives here; the
 * per-format element switches stay in their own parsers.
 */
export function pushPart(
  parts: Part[],
  polygons: Polygon[],
  name: string,
  counter: { value: number },
): void {
  parts.push({
    id: `part-${counter.value}`,
    name,
    polygons,
    sourceIndex: counter.value,
  });
  counter.value++;
}
