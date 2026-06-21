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
}

/** Configuration for the nesting algorithm */
export interface NestingConfig {
  sheet: MaterialSheet;
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
}

/** Result for a single sheet within a multi-sheet nesting */
export interface SheetResult {
  sheetIndex: number;
  placed: PlacedPart[];
  stripHeight: number;
  utilization: number;
}
