import type { Part, PlacedPart, NestingConfig, SheetResult } from '$lib/geometry/types';
import {
  optimize,
  optimizeIterative,
  COMMON_LINE_WEIGHT,
  type OptimizerConfig,
  type OptimizeProgress,
} from './optimizer';
import { computeSheetStats } from './stats';
import { boundingBox, polygonArea } from '$lib/geometry/polygon';
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
  /** Multi-start only: number of complete starts finished so far (#42). 0 for a single nest. */
  starts?: number;
}

/** A part is required unless it explicitly opts into the "optional" quantity priority (#43). */
function isRequired(part: Part): boolean {
  return (part.priority ?? 'required') === 'required';
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

function bboxArea(part: Part): number {
  const bb = boundingBox(part.polygons[0]);
  return bb.width * bb.height;
}

/**
 * Global multi-sheet assignment (#16): partition parts across exactly `k` sheets up front,
 * instead of greedily filling one sheet and overflowing the rest. Uses the Longest-Processing-
 * Time heuristic — parts in descending area, each assigned to the currently-lightest bin — so
 * load is balanced across the `k` sheets rather than front-loaded. Balancing matters because
 * the per-sheet GA packs a smaller, evener group more reliably than one over-full sheet plus a
 * sparse remainder, which is how a balanced split can fit a job into fewer sheets than greedy.
 * Returns `k` part groups (some may be empty when `k` exceeds the part count).
 */
export function partitionByArea(parts: Part[], k: number): Part[][] {
  const bins = Array.from({ length: Math.max(1, k) }, () => ({ parts: [] as Part[], area: 0 }));
  for (const part of sortByDescendingArea(parts)) {
    let lightest = 0;
    for (let i = 1; i < bins.length; i++) {
      if (bins[i].area < bins[lightest].area) lightest = i;
    }
    bins[lightest].parts.push(part);
    bins[lightest].area += bboxArea(part);
  }
  return bins.map((b) => b.parts);
}

/** Heaviest bin's total bounding-box area in the balanced k-partition — a cheap feasibility bound. */
function maxBinBboxArea(parts: Part[], k: number): number {
  let max = 0;
  for (const group of partitionByArea(parts, k)) {
    let area = 0;
    for (const p of group) area += bboxArea(p);
    if (area > max) max = area;
  }
  return max;
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
    gravityWeight: config.gravityWeight,
    remnantWeight: config.remnantWeight,
    // Common-line cutting (#43): turn on the shared-edge reward (undefined ⇒ off).
    commonLineWeight: config.commonLineCutting ? COMMON_LINE_WEIGHT : undefined,
  };
}

/**
 * Effective inter-part clearance for placement. Common-line cutting (#43) lets adjacent
 * parts abut so they can share a single cut, so the kerf gap drops to 0 in that mode; the
 * GA's shared-edge reward then drives parts edge-to-edge. Otherwise the configured kerf
 * keeps a beam-width gap between every part.
 */
function placementKerf(config: NestingConfig): number {
  return config.commonLineCutting ? 0 : config.kerf;
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
  // Optional parts ride along on sheets opened for required parts but never trigger a new
  // one (#43). Only enforced when the job actually has required parts; an all-optional job
  // keeps the normal overflow behavior so it still nests fully.
  const jobHasRequired = remaining.some(isRequired);

  while (remaining.length > 0) {
    const gen = optimizeIterative(remaining, config.sheet, placementKerf(config), optConfig);
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

    // Once every required part is placed, drop any remaining optional parts instead of
    // opening a fresh sheet just for them.
    if (jobHasRequired && !remaining.some(isRequired)) break;
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
  const jobHasRequired = remaining.some(isRequired);

  while (remaining.length > 0) {
    const placed = optimize(remaining, config.sheet, placementKerf(config), optConfig, onProgress);

    if (placed.length === 0) break;

    sheets.push(buildSheetResult(withOriginalGeometry(placed, originals), sheetIndex, config));

    const placedIds = new Set(placed.map((p) => p.part.id));
    remaining = remaining.filter((p) => !placedIds.has(p.id));
    sheetIndex++;

    // Drop leftover optional parts rather than opening a new sheet for them (#43).
    if (jobHasRequired && !remaining.some(isRequired)) break;
  }

  return buildNestingResult(sheets, restoreUnplaced(remaining, originals), config);
}

/** Total used material area of a result: sum over sheets of stripHeight × sheet width. Lower is denser. */
function usedArea(result: NestingResult): number {
  return result.sheets.reduce((sum, s) => sum + s.stripHeight * result.sheetWidth, 0);
}

/**
 * Strict "is a strictly better nest" comparator for multi-start. Feasibility first (fewer
 * unplaced parts), then fewer sheets, then a denser pack (less used material area).
 */
export function isBetterResult(a: NestingResult, b: NestingResult): boolean {
  if (a.unplaced.length !== b.unplaced.length) return a.unplaced.length < b.unplaced.length;
  if (a.sheets.length !== b.sheets.length) return a.sheets.length < b.sheets.length;
  return usedArea(a) < usedArea(b);
}

/** True area (outer minus cutouts) of a part's polygons. */
function partTrueArea(part: Part): number {
  let area = polygonArea(part.polygons[0]);
  for (let i = 1; i < part.polygons.length; i++) area -= polygonArea(part.polygons[i]);
  return area;
}

/**
 * Area lower bound on sheet count: a job whose parts total `A` of true area can never fit on
 * fewer than `ceil(A / sheetArea)` sheets. Multi-start stops once it reaches this bound with
 * everything placed, since no further restart can do better.
 */
export function sheetLowerBound(
  parts: Part[],
  quantities: Map<string, number>,
  sheet: { width: number; height: number },
): number {
  const sheetArea = sheet.width * sheet.height;
  if (sheetArea <= 0) return 1;
  let total = 0;
  for (const part of parts) total += partTrueArea(part) * (quantities.get(part.id) ?? 1);
  return Math.max(1, Math.ceil(total / sheetArea));
}

/** Default wall-clock budget for a full nest when the config doesn't specify one. */
export const DEFAULT_NEST_BUDGET_MS = 60_000;

/** Resolve the wall-clock budget for a nest from config/options, falling back to the default. */
export function resolveTimeBudget(config: NestingConfig, override?: number): number {
  if (override != null) return override;
  return config.timeBudgetMs && config.timeBudgetMs > 0
    ? config.timeBudgetMs
    : DEFAULT_NEST_BUDGET_MS;
}

/** A result is optimal when everything is placed on the fewest sheets physically possible. */
export function isOptimalResult(result: NestingResult, floor: number): boolean {
  return result.unplaced.length === 0 && result.sheets.length <= floor;
}

/**
 * Global multi-sheet assignment attempt (#16): partition the (already expanded/simplified)
 * parts into exactly `k` balanced groups and nest each group on its own sheet. Returns the
 * combined result; any part a group's GA can't place lands in `unplaced`, so the caller can
 * reject a `k` that didn't fit everything. Unlike the greedy fill-then-overflow path, this
 * decides which parts share a sheet before nesting, which can pack a near-boundary job into
 * fewer sheets. Reuses the per-sheet GA, so all placement/kerf/density behavior is identical.
 */
export function packIntoKSheets(
  prepared: Part[],
  originals: Map<string, Part>,
  config: NestingConfig,
  k: number,
): NestingResult {
  const optConfig = makeOptimizerConfig(config);
  const kerf = placementKerf(config);
  const sheets: SheetResult[] = [];
  const unplaced: Part[] = [];
  let sheetIndex = 0;

  for (const group of partitionByArea(prepared, k)) {
    if (group.length === 0) continue;
    const placed = optimize(group, config.sheet, kerf, optConfig);
    if (placed.length > 0) {
      sheets.push(buildSheetResult(withOriginalGeometry(placed, originals), sheetIndex, config));
      sheetIndex++;
    }
    const placedIds = new Set(placed.map((p) => p.part.id));
    for (const p of group) if (!placedIds.has(p.id)) unplaced.push(p);
  }

  return buildNestingResult(sheets, restoreUnplaced(unplaced, originals), config);
}

export interface MultiStartOptions {
  /** Wall-clock budget across all starts (ms). Defaults to the config's timeBudgetMs or 60s. */
  timeBudgetMs?: number;
  /** Hard cap on the number of starts. Defaults to a safety bound so degenerate instant nests can't spin. */
  maxStarts?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

// Safety bound on starts so a job that completes near-instantly (and can't reach the floor)
// can't spin the loop; real jobs are bounded first by the wall-clock budget.
const MAX_STARTS_DEFAULT = 1000;

// Generation cap for the global-assignment sweep's per-sheet nests (#16). Kept low so the
// sweep costs a small fraction of a random restart; balanced groups converge well within it.
const SWEEP_MAX_GENERATIONS = 40;

/**
 * Multi-start nesting as a generator: repeat the whole nest with the RNG advancing between
 * starts and keep the best result, yielding best-so-far progress throughout. Greedy placement
 * caps well below the optimum on dense jobs (e.g. lego-shelves: every constructive heuristic
 * places only 9–10/12), and a single GA run finds the rare one-sheet arrangement only
 * occasionally — so running several independent searches and keeping the best turns an
 * ~40%/run success rate into a reliable one. Bounded by the time budget and short-circuited
 * once the area lower bound is reached (can't do better). This is the single source of truth
 * for multi-start policy; the worker just drives it, the sync `nestPartsMultiStart` drains it.
 */
export function* nestPartsMultiStartIterative(
  input: NestingInput,
  opts: MultiStartOptions = {},
): Generator<NestingProgress, NestingResult, void> {
  const now = opts.now ?? Date.now;
  const budget = resolveTimeBudget(input.config, opts.timeBudgetMs);
  const maxStarts = opts.maxStarts ?? MAX_STARTS_DEFAULT;
  const deadline = now() + budget;
  const floor = sheetLowerBound(input.parts, input.quantities, input.config.sheet);

  // Prepared parts for the global-assignment sweep (#16): same expansion/simplification/order
  // the greedy path uses, so the two strategies nest comparable geometry.
  const expanded = expandParts(input.parts, input.quantities);
  const originals = new Map(expanded.map((p) => [p.id, p]));
  const prepared = sortByDescendingArea(simplifyPartsForNesting(expanded));

  let best: NestingResult | null = null;
  let starts = 0;
  let triedGlobal = false;
  while (true) {
    const gen = nestPartsIterative(input);
    let iter = gen.next();
    while (!iter.done) {
      const prog = iter.value;
      // Surface the best completed layout once we have one (stable), else the live run.
      yield {
        currentSheet: prog.currentSheet,
        generation: prog.generation,
        result: best ?? prog.result,
        starts,
      };
      iter = gen.next();
    }
    if (!best || isBetterResult(iter.value, best)) best = iter.value;
    starts++;
    if (isOptimalResult(best, floor)) break;

    // Global multi-sheet assignment sweep (#16): once a greedy best exists that places
    // everything but uses more than the area floor, try packing into fewer sheets via a
    // balanced partition. Run once (it's a bounded set of full nests), gated by the deadline,
    // and adopt only a strictly-better result — so it can cut sheet count but never raise it.
    if (!triedGlobal && best.unplaced.length === 0 && best.sheets.length > floor) {
      triedGlobal = true;
      // Cap the per-attempt generation budget so the sweep is a small fraction of a restart —
      // balanced groups are smaller/easier and converge fast, and a doomed dense attempt (e.g.
      // a too-low k) fails cheaply rather than eating the restart budget.
      const sweepConfig: NestingConfig = { ...input.config, maxGenerations: SWEEP_MAX_GENERATIONS };
      const sheetArea = input.config.sheet.width * input.config.sheet.height;
      for (let k = floor; k < best.sheets.length; k++) {
        if (now() >= deadline) break;
        // Skip a `k` whose balanced partition forces a bin past the sheet's bbox-area bound:
        // such a sheet can only fit via interlocking (overlapping bounding boxes), which the
        // bbox-greedy partition + per-sheet GA can't realize anyway. This keeps the sweep from
        // burning restart budget on dense interlocking jobs (e.g. lego, bbox ≈ 101% of sheet),
        // where reducing sheet count is a density problem (#26), not an assignment one.
        if (maxBinBboxArea(prepared, k) > sheetArea) continue;
        const candidate = packIntoKSheets(prepared, originals, sweepConfig, k);
        if (isBetterResult(candidate, best)) {
          best = candidate;
          yield { currentSheet: 0, generation: 0, result: best, starts };
        }
        if (isOptimalResult(best, floor)) break;
      }
      if (isOptimalResult(best, floor)) break;
    }

    if (starts >= maxStarts || now() >= deadline) break;
  }

  return best ?? EMPTY_RESULT(input.config);
}

/** Synchronous multi-start: drains {@link nestPartsMultiStartIterative} to its best result. */
export function nestPartsMultiStart(
  input: NestingInput,
  opts: MultiStartOptions = {},
): NestingResult {
  const gen = nestPartsMultiStartIterative(input, opts);
  let iter = gen.next();
  while (!iter.done) iter = gen.next();
  return iter.value;
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
