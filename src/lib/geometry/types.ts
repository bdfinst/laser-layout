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
	generations: number; // GA generations
}

/** Result for a single sheet within a multi-sheet nesting */
export interface SheetResult {
	sheetIndex: number;
	placed: PlacedPart[];
	stripHeight: number;
	utilization: number;
}
