import type { Part, PlacedPart, NestingConfig, SheetResult } from '$lib/geometry/types';
import {
  optimize,
  optimizeIterative,
  type OptimizerConfig,
  type OptimizeProgress,
} from './optimizer';
import { computeSheetStats } from './stats';
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
        name: qty > 1 ? `${part.name} (${i + 1})` : part.name,
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
    }),
  }));
}

/**
 * Swap a placed part's simplified geometry back to its full-fidelity original.
 *
 * Parts are simplified before nesting so NFP/placement math stays fast, but that
 * simplification (RDP at ~1% of the bounding box) erases small features — relief
 * cutouts at acute corners, the parallel edges of tabs. Simplification never moves
 * the coordinate frame, so the placement transform (x/y/rotation/mirror) computed
 * on the simplified polygon applies identically to the original. Restoring the
 * original geometry here keeps the rendered/exported result exact.
 */
function withOriginalGeometry(placed: PlacedPart[], originals: Map<string, Part>): PlacedPart[] {
  return placed.map((pp) => {
    const original = originals.get(pp.part.id);
    return original ? { ...pp, part: original } : pp;
  });
}

function restoreUnplaced(remaining: Part[], originals: Map<string, Part>): Part[] {
  return remaining.map((p) => originals.get(p.id) ?? p);
}

/**
 * Global First-Fit-Decreasing ordering (#16): place the largest parts first across the
 * whole job, not just within a sheet. Big parts seed early sheets and small parts fill the
 * gaps they leave, which tends to reduce the total sheet count. Preserves the per-sheet GA
 * and the overflow/generator contract — it only changes the order parts are considered in.
 */
function sortByDescendingArea(parts: Part[]): Part[] {
  return [...parts].sort((a, b) => {
    const ba = boundingBox(a.polygons[0]);
    const bb = boundingBox(b.polygons[0]);
    return bb.width * bb.height - ba.width * ba.height;
  });
}

export function makeOptimizerConfig(config: NestingConfig): OptimizerConfig {
  return {
    populationSize: config.populationSize,
    rotationSteps: config.rotationSteps,
    mutationRate: 0.3,
    // Safety cap proportional to the user's nominal generation budget (convergence
    // normally stops sooner). 3x headroom lets a still-improving run finish without
    // ballooning the worst case to a flat 200; floor keeps small budgets workable.
    maxGenerations: config.maxGenerations ?? Math.max(config.generations * 3, 120),
    stallWindow: config.stallWindow ?? 15,
    stallEpsilon: config.stallEpsilon ?? 0.005,
    useNfpPlacement: config.useNfpPlacement ?? false,
  };
}

function buildSheetResult(
  placed: PlacedPart[],
  sheetIndex: number,
  config: NestingConfig,
): SheetResult {
  const stats = computeSheetStats(placed, config.sheet);
  return {
    sheetIndex,
    placed,
    stripHeight: stats.stripHeight,
    utilization: stats.utilization,
  };
}

function buildNestingResult(
  sheets: SheetResult[],
  unplaced: Part[],
  config: NestingConfig,
): NestingResult {
  return {
    sheets,
    unplaced,
    sheetWidth: config.sheet.width,
    sheetHeight: config.sheet.height,
    totalPlaced: sheets.reduce((sum, s) => sum + s.placed.length, 0),
  };
}

const EMPTY_RESULT = (config: NestingConfig): NestingResult => ({
  sheets: [],
  unplaced: [],
  sheetWidth: config.sheet.width,
  sheetHeight: config.sheet.height,
  totalPlaced: 0,
});

/**
 * Multi-sheet nesting generator. Fills one sheet at a time,
 * yielding progress after each GA generation. When a sheet is done,
 * remaining parts move to the next sheet.
 */
export function* nestPartsIterative(
  input: NestingInput,
): Generator<NestingProgress, NestingResult, void> {
  const { parts, quantities, config } = input;
  const expanded = expandParts(parts, quantities);
  const originals = new Map(expanded.map((p) => [p.id, p]));
  let remaining = sortByDescendingArea(simplifyPartsForNesting(expanded));

  if (remaining.length === 0) {
    return EMPTY_RESULT(config);
  }

  const optConfig = makeOptimizerConfig(config);
  const sheets: SheetResult[] = [];
  let sheetIndex = 0;

  while (remaining.length > 0) {
    const gen = optimizeIterative(remaining, config.sheet, config.kerf, optConfig);
    // eslint-disable-next-line no-useless-assignment
    let lastPlacement: PlacedPart[] = [];

    let iter: IteratorResult<OptimizeProgress, PlacedPart[]>;
    do {
      iter = gen.next();
      if (!iter.done) {
        lastPlacement = iter.value.bestPlacement;
        // Build intermediate result showing current sheet progress
        const currentSheet = buildSheetResult(
          withOriginalGeometry(lastPlacement, originals),
          sheetIndex,
          config,
        );
        const intermediateSheets = [...sheets, currentSheet];
        const placedIds = new Set(lastPlacement.map((p) => p.part.id));
        const unplaced = restoreUnplaced(
          remaining.filter((p) => !placedIds.has(p.id)),
          originals,
        );

        yield {
          currentSheet: sheetIndex,
          generation: iter.value.generation,
          result: buildNestingResult(intermediateSheets, unplaced, config),
        };
      }
    } while (!iter.done);

    const finalPlacement = iter.value;
    if (finalPlacement.length === 0) {
      // Nothing could be placed — these parts don't fit on this sheet size
      break;
    }

    sheets.push(
      buildSheetResult(withOriginalGeometry(finalPlacement, originals), sheetIndex, config),
    );

    // Remove placed parts from remaining
    const placedIds = new Set(finalPlacement.map((p) => p.part.id));
    remaining = remaining.filter((p) => !placedIds.has(p.id));
    sheetIndex++;
  }

  return buildNestingResult(sheets, restoreUnplaced(remaining, originals), config);
}

/**
 * Synchronous multi-sheet nesting.
 */
export function nestParts(
  input: NestingInput,
  onProgress?: (generation: number, bestFitness: number) => void,
): NestingResult {
  const { parts, quantities, config } = input;
  const expanded = expandParts(parts, quantities);
  const originals = new Map(expanded.map((p) => [p.id, p]));
  let remaining = sortByDescendingArea(simplifyPartsForNesting(expanded));

  if (remaining.length === 0) {
    return EMPTY_RESULT(config);
  }

  const optConfig = makeOptimizerConfig(config);
  const sheets: SheetResult[] = [];
  let sheetIndex = 0;

  while (remaining.length > 0) {
    const placed = optimize(remaining, config.sheet, config.kerf, optConfig, onProgress);

    if (placed.length === 0) break;

    sheets.push(buildSheetResult(withOriginalGeometry(placed, originals), sheetIndex, config));

    const placedIds = new Set(placed.map((p) => p.part.id));
    remaining = remaining.filter((p) => !placedIds.has(p.id));
    sheetIndex++;
  }

  return buildNestingResult(sheets, restoreUnplaced(remaining, originals), config);
}

export function computeMinimumSheet(
  parts: Part[],
  quantities: Map<string, number>,
  kerf: number,
): {
  minWidth: number;
  minHeight: number;
  totalArea: number;
  largestWidth: number;
  largestHeight: number;
} {
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
