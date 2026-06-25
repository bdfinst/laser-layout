import type { Part } from './types';
import { boundingBox } from './polygon';

/** Display geometry for a part's outline thumbnail. */
export interface PartThumbnail {
  /** Outer-polygon bounding-box width (mm). */
  width: number;
  /** Outer-polygon bounding-box height (mm). */
  height: number;
  /** Padded SVG `viewBox` around the part's outer polygon. */
  viewBox: string;
  /** Stroke width proportional to the part's larger dimension. */
  strokeWidth: number;
}

/**
 * Compute the thumbnail display geometry for a part once, at a derivation boundary, rather than
 * recomputing `boundingBox` per render. A padded viewBox frames the outer polygon and the stroke
 * width scales with the part's larger dimension so outlines read consistently at any size; the
 * bounding-box dimensions are returned too for the size label.
 */
export function partThumbnail(part: Part): PartThumbnail {
  const bb = boundingBox(part.polygons[0]);
  const span = Math.max(bb.width, bb.height);
  const pad = span * 0.08;
  return {
    width: bb.width,
    height: bb.height,
    viewBox: `${bb.minX - pad} ${bb.minY - pad} ${bb.width + pad * 2} ${bb.height + pad * 2}`,
    strokeWidth: span * 0.02,
  };
}
