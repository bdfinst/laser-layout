export interface Point {
  x: number;
  y: number;
}

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

/** A polygon is an ordered list of points forming a closed shape */
export type Polygon = Point[];

/** A part is a named polygon with an ID, ready for nesting */
export interface Part {
  id: string;
  name: string;
  polygons: Polygon[]; // outer boundary + any inner cutouts
  sourceIndex: number; // index in the original file
  /** When true, the nester must not mirror/flip this part (orientation-specific). */
  lockOrientation?: boolean;
  /**
   * Quantity priority. `"required"` (default) — the engine opens new sheets until every
   * copy is placed. `"optional"` — copies that don't fit alongside the required parts are
   * dropped rather than forcing a new sheet ("fit as many as possible").
   */
  priority?: 'required' | 'optional';
  /**
   * When true, restrict this part's rotation to 0° / 180° only (grain / directional
   * material). Extends the per-part orientation lock: the lock forbids mirroring, this
   * forbids cross-grain rotation. Independent flags — a part may set either or both.
   */
  grainConstraint?: boolean;
}

/** A placed part after nesting */
export interface PlacedPart {
  part: Part;
  x: number;
  y: number;
  rotation: number; // radians
  mirror?: boolean; // reflected across the vertical axis before rotation
}

/** Material sheet dimensions in mm */
export interface MaterialSheet {
  width: number;
  height: number;
  /**
   * Optional supply cap: the maximum number of sheets of this size the engine may open.
   * Omitted ⇒ unlimited supply. (Enforcement lands in a later slice; the field is part of
   * the authoritative size model here.)
   */
  maxCount?: number;
}

/** Configuration for the nesting algorithm */
export interface NestingConfig {
  sheet: MaterialSheet;
  /**
   * Available material sheet sizes. When present and non-empty this is the authoritative
   * source of sizes and the single `sheet` is ignored (normalize via {@link availableSheets}).
   * When omitted, `sheet` is treated as the sole available size. An empty list is invalid and
   * rejected at the engine boundary.
   */
  sheets?: MaterialSheet[];
  kerf: number; // spacing between parts in mm, default 1
  rotationSteps: number; // number of rotation angles to try
  populationSize: number; // GA population size
  generations: number; // GA generations (baseline for the convergence safety cap)
  // Convergence-based termination (optional; defaulted in makeOptimizerConfig).
  stallWindow?: number; // generations without meaningful improvement before stopping
  stallEpsilon?: number; // minimum relative improvement that counts as progress
  maxGenerations?: number; // hard safety cap on generations
  // Opt-in NFP-based placement (epic #24, P3–P5): exact-phase candidate seats, compactness
  // selection, and NFP-clearance collision. Off by default — denser interlock candidates
  // exist but the path is ~3–4x slower and not yet a net bench win pending tuning.
  useNfpPlacement?: boolean;
  // Wall-clock budget for a full nest, in milliseconds. The GA runs until it converges or
  // this budget is reached (checked at generation boundaries), then returns the best layout
  // so far. Undefined ⇒ the worker's default ceiling.
  timeBudgetMs?: number;
  // Remnant-aware fitness weights (#41): a mild pull toward a clustered pack (gravity) and
  // toward one large reusable offcut (remnant). Small by design; undefined ⇒ optimizer
  // defaults. Set to 0 to disable a term.
  gravityWeight?: number;
  remnantWeight?: number;
  // Common-line cutting (#43): when true, parts are allowed to abut (placement clearance
  // drops to 0) and the GA fitness rewards coincident shared edges, so adjacent parts share
  // a single cut line. Export then emits each shared edge once. Off by default.
  commonLineCutting?: boolean;
}

/** Result for a single sheet within a multi-sheet nesting */
export interface SheetResult {
  sheetIndex: number;
  placed: PlacedPart[];
  stripHeight: number;
  utilization: number;
  /** Dimensions (mm) of the material sheet this layout was placed on. */
  sheetWidth: number;
  sheetHeight: number;
}

/**
 * Resolve the available material sheet sizes from a nesting config.
 *
 * The `sheets` list is the authoritative source: when present it wins and the single `sheet`
 * is ignored. When `sheets` is omitted, the single `sheet` is normalized to a one-element list.
 * A present-but-empty `sheets` list is invalid and throws. A size's omitted `maxCount` means
 * unlimited supply (the field is returned untouched).
 */
export function availableSheets(config: NestingConfig): MaterialSheet[] {
  if (config.sheets !== undefined) {
    if (config.sheets.length === 0) {
      throw new Error('No sheet sizes configured: the available sheet-size list is empty.');
    }
    return config.sheets;
  }
  return [config.sheet];
}
