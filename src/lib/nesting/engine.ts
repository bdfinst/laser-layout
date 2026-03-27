import type { Part, PlacedPart, NestingConfig, SheetResult } from '$lib/geometry/types';
import { optimize, optimizeIterative, type OptimizerConfig, type OptimizeProgress } from './optimizer';
import { computeSheetStats } from './placement';
import { boundingBox } from '$lib/geometry/polygon';
import { simplifyPolygon } from '$lib/geometry/simplify';

export interface NestingInput {
	parts: Part[];
	quantities: Map<string, number>;
	config: NestingConfig;
}

export interface NestingResult {
	sheets: SheetResult[];
	unplaced: Part[];
	sheetWidth: number;
	sheetHeight: number;
	totalPlaced: number;
}

export interface NestingProgress {
	currentSheet: number;
	generation: number;
	result: NestingResult;
}

function expandParts(parts: Part[], quantities: Map<string, number>): Part[] {
	const expanded: Part[] = [];
	for (const part of parts) {
		const qty = quantities.get(part.id) ?? 1;
		for (let i = 0; i < qty; i++) {
			expanded.push({
				...part,
				id: `${part.id}_${i}`,
				name: qty > 1 ? `${part.name} (${i + 1})` : part.name
			});
		}
	}
	return expanded;
}

function simplifyPartsForNesting(parts: Part[]): Part[] {
	return parts.map((part) => ({
		...part,
		polygons: part.polygons.map((poly) => {
			if (poly.length <= 10) return poly;
			const bb = boundingBox(poly);
			const tolerance = Math.max(bb.width, bb.height) * 0.01;
			return simplifyPolygon(poly, tolerance);
		})
	}));
}

function makeOptimizerConfig(config: NestingConfig): OptimizerConfig {
	return {
		populationSize: config.populationSize,
		generations: config.generations,
		mutationRate: 0.3,
		rotationSteps: config.rotationSteps
	};
}

function buildSheetResult(placed: PlacedPart[], sheetIndex: number, config: NestingConfig): SheetResult {
	const stats = computeSheetStats(placed, config.sheet);
	return {
		sheetIndex,
		placed,
		stripHeight: stats.stripHeight,
		utilization: stats.utilization
	};
}

function buildNestingResult(sheets: SheetResult[], unplaced: Part[], config: NestingConfig): NestingResult {
	return {
		sheets,
		unplaced,
		sheetWidth: config.sheet.width,
		sheetHeight: config.sheet.height,
		totalPlaced: sheets.reduce((sum, s) => sum + s.placed.length, 0)
	};
}

const EMPTY_RESULT = (config: NestingConfig): NestingResult => ({
	sheets: [],
	unplaced: [],
	sheetWidth: config.sheet.width,
	sheetHeight: config.sheet.height,
	totalPlaced: 0
});

/**
 * Multi-sheet nesting generator. Fills one sheet at a time,
 * yielding progress after each GA generation. When a sheet is done,
 * remaining parts move to the next sheet.
 */
export function* nestPartsIterative(
	input: NestingInput
): Generator<NestingProgress, NestingResult, void> {
	const { parts, quantities, config } = input;
	let remaining = simplifyPartsForNesting(expandParts(parts, quantities));

	if (remaining.length === 0) {
		return EMPTY_RESULT(config);
	}

	const optConfig = makeOptimizerConfig(config);
	const sheets: SheetResult[] = [];
	let sheetIndex = 0;

	while (remaining.length > 0) {
		const gen = optimizeIterative(remaining, config.sheet, config.kerf, optConfig);
		let lastPlacement: PlacedPart[] = [];

		let iter: IteratorResult<OptimizeProgress, PlacedPart[]>;
		do {
			iter = gen.next();
			if (!iter.done) {
				lastPlacement = iter.value.bestPlacement;
				// Build intermediate result showing current sheet progress
				const currentSheet = buildSheetResult(lastPlacement, sheetIndex, config);
				const intermediateSheets = [...sheets, currentSheet];
				const placedIds = new Set(lastPlacement.map((p) => p.part.id));
				const unplaced = remaining.filter((p) => !placedIds.has(p.id));

				yield {
					currentSheet: sheetIndex,
					generation: iter.value.generation,
					result: buildNestingResult(intermediateSheets, unplaced, config)
				};
			}
		} while (!iter.done);

		const finalPlacement = iter.value;
		if (finalPlacement.length === 0) {
			// Nothing could be placed — these parts don't fit on this sheet size
			break;
		}

		sheets.push(buildSheetResult(finalPlacement, sheetIndex, config));

		// Remove placed parts from remaining
		const placedIds = new Set(finalPlacement.map((p) => p.part.id));
		remaining = remaining.filter((p) => !placedIds.has(p.id));
		sheetIndex++;
	}

	return buildNestingResult(sheets, remaining, config);
}

/**
 * Synchronous multi-sheet nesting.
 */
export function nestParts(
	input: NestingInput,
	onProgress?: (generation: number, bestFitness: number) => void
): NestingResult {
	const { parts, quantities, config } = input;
	let remaining = simplifyPartsForNesting(expandParts(parts, quantities));

	if (remaining.length === 0) {
		return EMPTY_RESULT(config);
	}

	const optConfig = makeOptimizerConfig(config);
	const sheets: SheetResult[] = [];
	let sheetIndex = 0;

	while (remaining.length > 0) {
		const placed = optimize(remaining, config.sheet, config.kerf, optConfig, onProgress);

		if (placed.length === 0) break;

		sheets.push(buildSheetResult(placed, sheetIndex, config));

		const placedIds = new Set(placed.map((p) => p.part.id));
		remaining = remaining.filter((p) => !placedIds.has(p.id));
		sheetIndex++;
	}

	return buildNestingResult(sheets, remaining, config);
}

export function computeMinimumSheet(
	parts: Part[],
	quantities: Map<string, number>,
	kerf: number
): { minWidth: number; minHeight: number; totalArea: number; largestWidth: number; largestHeight: number } {
	const expanded = expandParts(parts, quantities);
	if (expanded.length === 0) {
		return { minWidth: 0, minHeight: 0, totalArea: 0, largestWidth: 0, largestHeight: 0 };
	}

	let totalArea = 0;
	let largestWidth = 0;
	let largestHeight = 0;

	for (const part of expanded) {
		const poly = part.polygons[0];
		const bb = boundingBox(poly);
		const w = Math.min(bb.width, bb.height);
		const h = Math.max(bb.width, bb.height);
		totalArea += (bb.width + kerf) * (bb.height + kerf);
		if (w > largestWidth) largestWidth = w;
		if (h > largestHeight) largestHeight = h;
	}

	const minDim = Math.max(largestWidth, 1);
	const minWidth = Math.ceil(minDim);
	const minHeight = Math.ceil(Math.max(largestHeight, totalArea / minDim));

	return { minWidth, minHeight, totalArea, largestWidth, largestHeight };
}
