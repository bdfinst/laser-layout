import type {
  Part,
  PlacedPart,
  NestingConfig,
  SheetResult,
  MaterialSheet,
} from '$lib/geometry/types';
import { availableSheets } from '$lib/geometry/types';
import {
  optimize,
  optimizeIterative,
  COMMON_LINE_WEIGHT,
  type OptimizerConfig,
  type OptimizeProgress,
} from './optimizer';
import { computeSheetStats } from './stats';
import { bottomLeftFill } from './placement';
import { polygonsInterpenetrate } from './nfp';
import { boundingBox, polygonArea, getPlacedPolygons } from '$lib/geometry/polygon';
import { simplifyPolygon } from '$lib/geometry/simplify';
import { createSupplyPool } from './supply-pool';

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
 * Finalize a committed (simplified-geometry) sheet placement onto full-fidelity geometry.
 *
 * The GA searches on RDP-simplified outlines for speed, so a placement that is collision-free
 * on the simplified shapes can still overlap once the original geometry is restored — the
 * simplified outline can sit up to its RDP tolerance *inside* the real outline, and a convex
 * bump shaved off by simplification then pokes into a neighbour. With a kerf gap that slack is
 * absorbed, but common-line cutting drives the placement gap to 0, so the slack surfaces as
 * overlapping cuts. To guarantee the rendered/exported result is overlap-free, re-run the
 * deterministic bottom-left fill on the ORIGINAL outlines, reusing the GA's winning part order,
 * rotations and mirrors. The exact collision test (concave-correct) then settles real positions
 * that cannot interpenetrate. A part that no longer fits is simply omitted here and flows back to
 * `remaining` via the caller's placed-id diff, so it overflows to the next sheet rather than
 * overlapping. Scoped to common-line mode; every other path keeps the cheap geometry swap and is
 * byte-for-byte unchanged.
 *
 * The re-seat runs WITHOUT the NFP cache even when the GA used it: the GA already chose the part
 * order on fast simplified geometry, and full-fidelity orbiting NFP (hundreds of vertices per
 * part, all pairs) is far too slow to repeat here. Plain bottom-left fill with concave anchors +
 * the exact concave-correct collision test is enough to settle an overlap-free packing in that
 * order, and runs in a fraction of the time.
 */
function finalizePlacement(
  placed: PlacedPart[],
  originals: Map<string, Part>,
  config: NestingConfig,
  sheet: MaterialSheet,
): PlacedPart[] {
  if (placed.length === 0) return withOriginalGeometry(placed, originals);

  // Deterministic re-fill on full-fidelity outlines, reusing the GA's winning order/rotation/
  // mirror. The exact concave-correct collision settles real, non-interpenetrating positions and
  // omits any part that no longer fits (it overflows rather than overlapping).
  const reseat = (): PlacedPart[] =>
    bottomLeftFill(
      placed.map((pp) => ({
        part: originals.get(pp.part.id) ?? pp.part,
        rotation: pp.rotation,
        mirror: pp.mirror,
      })),
      sheet,
      placementKerf(config),
      true,
      null,
    );

  // Common-line cutting drives the placement gap to 0, so the simplification slack always
  // surfaces as overlapping cuts — re-seat unconditionally.
  if (config.commonLineCutting) return reseat();

  // Otherwise the cheap geometry swap is correct UNLESS the simplification slack (RDP tolerance
  // is ~1% of the bbox, which exceeds the kerf on large parts) lets the full-fidelity outlines
  // interpenetrate where the simplified ones only touched — exactly what the tight NFP feasible
  // seats (#26) expose. Re-seat only when that actually happens, so density-optimal nests keep
  // the GA's NFP packing and only a genuinely overlapping sheet pays for the deterministic refill.
  const swapped = withOriginalGeometry(placed, originals);
  return anyInterpenetration(swapped) ? reseat() : swapped;
}

/** True if any two placed parts' full-fidelity outer outlines interpenetrate (bbox-prefiltered). */
function anyInterpenetration(placed: PlacedPart[]): boolean {
  const items = placed.map((pp) => {
    const poly = getPlacedPolygons(pp)[0];
    return { poly, bb: boundingBox(poly) };
  });
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (a.bb.maxX <= b.bb.minX || b.bb.maxX <= a.bb.minX) continue;
      if (a.bb.maxY <= b.bb.minY || b.bb.maxY <= a.bb.minY) continue;
      if (polygonsInterpenetrate(a.poly, b.poly)) return true;
    }
  }
  return false;
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

/** True if a part's bounding box fits a sheet in either 90° orientation. */
function partFitsSheet(part: Part, sheet: MaterialSheet): boolean {
  const bb = boundingBox(part.polygons[0]);
  return (
    (bb.width <= sheet.width && bb.height <= sheet.height) ||
    (bb.height <= sheet.width && bb.width <= sheet.height)
  );
}

/**
 * Split parts into those that fit at least one available size and those that fit none.
 * Permanently-unfittable parts (fit NO size) can never be placed; separating them once keeps
 * them from stranding the parts that DO fit and stops the sheet-opening loop spinning on an
 * unplaceable largest part.
 */
function partitionFittable(
  parts: Part[],
  sizes: MaterialSheet[],
): { fittable: Part[]; unfittable: Part[] } {
  const fittable: Part[] = [];
  const unfittable: Part[] = [];
  for (const p of parts) {
    if (sizes.some((s) => partFitsSheet(p, s))) fittable.push(p);
    else unfittable.push(p);
  }
  return { fittable, unfittable };
}

/** The remaining part with the largest bounding-box area (the one the next sheet must seat). */
function largestPartByArea(parts: Part[]): Part | undefined {
  let best: Part | undefined;
  let bestArea = -Infinity;
  for (const p of parts) {
    const a = bboxArea(p);
    if (a > bestArea) {
      bestArea = a;
      best = p;
    }
  }
  return best;
}

/** A cheap, GA-free score for how a candidate size would serve the remaining parts. */
export interface SizeEvaluation {
  /** This size's own committed material area (`width × height`). */
  committedArea: number;
  /** Estimated number of remaining parts the size could hold (see {@link evaluateSizeFit}). */
  placedCount: number;
}

/**
 * Cheap, GA-free estimate of how a size would serve the remaining parts, used to pick the ONE
 * size to actually run the GA on (a full GA per candidate would multiply per-start cost).
 *
 * HEURISTIC: walk the parts and greedily "spend" the sheet's area budget — count a part as
 * placed when its kerf-padded bounding-box area still fits the remaining budget and the part
 * fits the sheet in some 90° orientation. This is a fragmentation-blind upper bound, but it is
 * monotonic in sheet area (a larger sheet never scores fewer parts than a smaller one), which is
 * all the selector needs to rank candidates by "most parts placed, then least committed area".
 */
function evaluateSizeFit(parts: Part[], sheet: MaterialSheet, kerf: number): SizeEvaluation {
  const committedArea = sheet.width * sheet.height;
  let budget = committedArea;
  let placedCount = 0;
  for (const part of parts) {
    if (!partFitsSheet(part, sheet)) continue;
    const bb = boundingBox(part.polygons[0]);
    const cell = (bb.width + kerf) * (bb.height + kerf);
    if (cell <= budget) {
      budget -= cell;
      placedCount++;
    }
  }
  return { committedArea, placedCount };
}

/**
 * Choose which available size to open for the next sheet, under the Slice-2 objective: place the
 * most parts, then commit the least material area. `evaluate` scores each candidate (injected so
 * tests can stub deterministic scores). Sizes that cannot contain the largest remaining part are
 * discarded first — a sheet that can't seat the part we are trying to place is never a valid
 * choice. Returns null when no size survives, so the caller routes the remaining parts to
 * `unplaced` without opening an empty sheet.
 */
export function selectSheetForNextOpen(
  remainingParts: Part[],
  candidateSizes: MaterialSheet[],
  evaluate: (size: MaterialSheet) => SizeEvaluation,
): MaterialSheet | null {
  const largest = largestPartByArea(remainingParts);
  const survivors = largest
    ? candidateSizes.filter((s) => partFitsSheet(largest, s))
    : candidateSizes;

  let best: MaterialSheet | null = null;
  let bestEval: SizeEvaluation | null = null;
  for (const size of survivors) {
    const e = evaluate(size);
    if (
      bestEval === null ||
      e.placedCount > bestEval.placedCount ||
      (e.placedCount === bestEval.placedCount && e.committedArea < bestEval.committedArea)
    ) {
      best = size;
      bestEval = e;
    }
  }
  return best;
}

/** Top-level default dimensions for a result: the first opened sheet's size, else the primary. */
function topLevelDimensions(sheets: SheetResult[], primary: MaterialSheet): MaterialSheet {
  return sheets.length > 0
    ? { width: sheets[0].sheetWidth, height: sheets[0].sheetHeight }
    : primary;
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
  sheet: MaterialSheet,
): SheetResult {
  const stats = computeSheetStats(placed, sheet);
  return {
    sheetIndex,
    placed,
    stripHeight: stats.stripHeight,
    utilization: stats.utilization,
    sheetWidth: sheet.width,
    sheetHeight: sheet.height,
  };
}

function buildNestingResult(
  sheets: SheetResult[],
  unplaced: Part[],
  sheet: MaterialSheet,
): NestingResult {
  return {
    sheets,
    unplaced,
    sheetWidth: sheet.width,
    sheetHeight: sheet.height,
    totalPlaced: sheets.reduce((sum, s) => sum + s.placed.length, 0),
  };
}

const EMPTY_RESULT = (sheet: MaterialSheet): NestingResult => ({
  sheets: [],
  unplaced: [],
  sheetWidth: sheet.width,
  sheetHeight: sheet.height,
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
  // Resolve (and validate) the available sizes; each opened sheet picks the size that best
  // serves the parts still to be placed (least committed area for the most parts).
  const candidateSizes = availableSheets(config);
  const primary = candidateSizes[0];
  const expanded = expandParts(parts, quantities);
  const originals = new Map(expanded.map((p) => [p.id, p]));
  let remaining = sortByDescendingArea(simplifyPartsForNesting(expanded));

  if (remaining.length === 0) {
    return EMPTY_RESULT(primary);
  }

  // Set permanently-unfittable parts (fit NO configured size) aside once so they don't strand
  // the parts that DO fit.
  const { fittable, unfittable } = partitionFittable(remaining, candidateSizes);
  remaining = fittable;

  // Per-size supply: each opened sheet consumes one of its chosen size; an exhausted size
  // leaves the candidate set and parts that fit only exhausted sizes can no longer be placed.
  const pool = createSupplyPool(candidateSizes);
  const supplyStranded: Part[] = [];

  const optConfig = makeOptimizerConfig(config);
  const sheets: SheetResult[] = [];
  let sheetIndex = 0;
  // Optional parts ride along on sheets opened for required parts but never trigger a new
  // one (#43). Only enforced when the job actually has required parts; an all-optional job
  // keeps the normal overflow behavior so it still nests fully.
  const jobHasRequired = remaining.some(isRequired);

  while (remaining.length > 0) {
    const inSupply = pool.inSupplySizes();
    // Re-partition against CURRENT supply: a part whose only fitting size is now exhausted can
    // never be placed (supply only shrinks), so set it aside. When nothing fits an in-supply
    // size, stop — the leftover (incl. required parts) flows to `unplaced` below.
    const { fittable: placeable, unfittable: stranded } = partitionFittable(remaining, inSupply);
    if (placeable.length === 0) break;
    if (stranded.length > 0) {
      supplyStranded.push(...stranded);
      remaining = placeable;
    }

    // Pick this sheet's size from the in-supply candidates for the remaining placeable parts;
    // null is a defensive guard — every placeable part fits ≥1 in-supply size.
    const sheet = selectSheetForNextOpen(remaining, inSupply, (s) =>
      evaluateSizeFit(remaining, s, placementKerf(config)),
    );
    if (!sheet) break;
    const gen = optimizeIterative(remaining, sheet, placementKerf(config), optConfig);
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
          sheet,
        );
        const intermediateSheets = [...sheets, currentSheet];
        const placedIds = new Set(lastPlacement.map((p) => p.part.id));
        const unplaced = restoreUnplaced(
          [...remaining.filter((p) => !placedIds.has(p.id)), ...unfittable],
          originals,
        );

        yield {
          currentSheet: sheetIndex,
          generation: iter.value.generation,
          result: buildNestingResult(intermediateSheets, unplaced, sheet),
        };
      }
    } while (!iter.done);

    const finalPlacement = iter.value;
    if (finalPlacement.length === 0) {
      // Nothing could be placed — these parts don't fit on this sheet size
      break;
    }

    const finalized = finalizePlacement(finalPlacement, originals, config, sheet);
    // The common-line exact pass re-seats on full geometry; if nothing seats, stop to avoid
    // looping forever on parts that can't be made overlap-free on this sheet size.
    if (finalized.length === 0) break;

    sheets.push(buildSheetResult(finalized, sheetIndex, sheet));
    pool.decrement(sheet);

    // Remove placed parts from remaining
    const placedIds = new Set(finalized.map((p) => p.part.id));
    remaining = remaining.filter((p) => !placedIds.has(p.id));
    sheetIndex++;

    // Once every required part is placed, drop any remaining optional parts instead of
    // opening a fresh sheet just for them.
    if (jobHasRequired && !remaining.some(isRequired)) break;
  }

  return buildNestingResult(
    sheets,
    restoreUnplaced([...remaining, ...supplyStranded, ...unfittable], originals),
    topLevelDimensions(sheets, primary),
  );
}

/**
 * Synchronous multi-sheet nesting.
 */
export function nestParts(
  input: NestingInput,
  onProgress?: (generation: number, bestFitness: number) => void,
): NestingResult {
  const { parts, quantities, config } = input;
  const candidateSizes = availableSheets(config);
  const primary = candidateSizes[0];
  const expanded = expandParts(parts, quantities);
  const originals = new Map(expanded.map((p) => [p.id, p]));
  let remaining = sortByDescendingArea(simplifyPartsForNesting(expanded));

  if (remaining.length === 0) {
    return EMPTY_RESULT(primary);
  }

  // Set permanently-unfittable parts (fit NO configured size) aside once so they don't strand
  // the parts that DO fit.
  const { fittable, unfittable } = partitionFittable(remaining, candidateSizes);
  remaining = fittable;

  // Per-size supply state (see nestPartsIterative): exhausted sizes leave the candidate set.
  const pool = createSupplyPool(candidateSizes);
  const supplyStranded: Part[] = [];

  const optConfig = makeOptimizerConfig(config);
  const sheets: SheetResult[] = [];
  let sheetIndex = 0;
  const jobHasRequired = remaining.some(isRequired);

  while (remaining.length > 0) {
    const inSupply = pool.inSupplySizes();
    // Re-partition against current supply; set aside parts that fit only exhausted sizes and
    // stop when nothing remaining fits an in-supply size.
    const { fittable: placeable, unfittable: stranded } = partitionFittable(remaining, inSupply);
    if (placeable.length === 0) break;
    if (stranded.length > 0) {
      supplyStranded.push(...stranded);
      remaining = placeable;
    }

    // Pick this sheet's size from the in-supply candidates; null is a defensive guard.
    const sheet = selectSheetForNextOpen(remaining, inSupply, (s) =>
      evaluateSizeFit(remaining, s, placementKerf(config)),
    );
    if (!sheet) break;
    const placed = optimize(remaining, sheet, placementKerf(config), optConfig, onProgress);

    if (placed.length === 0) break;

    const finalized = finalizePlacement(placed, originals, config, sheet);
    if (finalized.length === 0) break;

    sheets.push(buildSheetResult(finalized, sheetIndex, sheet));
    pool.decrement(sheet);

    const placedIds = new Set(finalized.map((p) => p.part.id));
    remaining = remaining.filter((p) => !placedIds.has(p.id));
    sheetIndex++;

    // Drop leftover optional parts rather than opening a new sheet for them (#43).
    if (jobHasRequired && !remaining.some(isRequired)) break;
  }

  return buildNestingResult(
    sheets,
    restoreUnplaced([...remaining, ...supplyStranded, ...unfittable], originals),
    topLevelDimensions(sheets, primary),
  );
}

/**
 * Total committed material area of a result: sum over every opened sheet of its OWN
 * `width × height`. This is the "waste" objective — the material you must buy/cut from,
 * regardless of how densely each sheet is packed. Lower is less waste. Using each sheet's own
 * dimensions (not the result-level default) keeps it correct once sheet sizes can differ.
 */
function committedArea(result: NestingResult): number {
  return result.sheets.reduce((sum, s) => sum + s.sheetWidth * s.sheetHeight, 0);
}

/**
 * Total strip area of a result: sum over sheets of `stripHeight × sheet width`, using each
 * sheet's own width. This is the density signal — how much of each sheet the packing actually
 * occupies vertically — preserved as a lower-priority tie-break so multi-start still
 * discriminates between equally-committed, equal-count packings.
 */
function stripArea(result: NestingResult): number {
  return result.sheets.reduce((sum, s) => sum + s.stripHeight * s.sheetWidth, 0);
}

/**
 * Strict "is a strictly better nest" comparator for multi-start. Feasibility first (fewer
 * unplaced parts), then least committed material area (the waste objective), then fewer sheets,
 * then a denser pack (less total strip area). For a single uniform sheet size committed area is
 * monotonic in sheet count, so this ordering is identical to the prior
 * feasibility→fewer-sheets→density behavior.
 */
export function isBetterResult(a: NestingResult, b: NestingResult): boolean {
  if (a.unplaced.length !== b.unplaced.length) return a.unplaced.length < b.unplaced.length;
  const ca = committedArea(a);
  const cb = committedArea(b);
  if (ca !== cb) return ca < cb;
  if (a.sheets.length !== b.sheets.length) return a.sheets.length < b.sheets.length;
  return stripArea(a) < stripArea(b);
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
  sheet: MaterialSheet,
): number {
  const sheetArea = sheet.width * sheet.height;
  if (sheetArea <= 0) return 1;
  let total = 0;
  for (const part of parts) total += partTrueArea(part) * (quantities.get(part.id) ?? 1);
  return Math.max(1, Math.ceil(total / sheetArea));
}

/** The available size with the greatest area — the size that determines the area lower bound. */
function largestSheet(sizes: MaterialSheet[]): MaterialSheet {
  return sizes.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
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
  const candidateSizes = availableSheets(config);
  const primary = candidateSizes[0];
  const optConfig = makeOptimizerConfig(config);
  const kerf = placementKerf(config);
  const sheets: SheetResult[] = [];
  // Set permanently-unfittable parts aside up front so a group can't strand the parts that fit.
  const { fittable, unfittable } = partitionFittable(prepared, candidateSizes);
  const unplaced: Part[] = [...unfittable];
  // Per-size supply shared across the K groups: a group must draw an in-supply size, and a
  // k-packing that can't fit every group within supply simply lands parts in `unplaced` (so the
  // caller's comparator never adopts a cap-violating result).
  const pool = createSupplyPool(candidateSizes);
  let sheetIndex = 0;

  for (const group of partitionByArea(fittable, k)) {
    if (group.length === 0) continue;
    // Choose this group's size independently (no cross-group combinatorics): the in-supply size
    // minimizing the group's committed area, consistent with selectSheetForNextOpen.
    const sheet = selectSheetForNextOpen(group, pool.inSupplySizes(), (s) =>
      evaluateSizeFit(group, s, kerf),
    );
    if (!sheet) {
      for (const p of group) unplaced.push(p);
      continue;
    }
    const placed = optimize(group, sheet, kerf, optConfig);
    const finalized = finalizePlacement(placed, originals, config, sheet);
    if (finalized.length > 0) {
      sheets.push(buildSheetResult(finalized, sheetIndex, sheet));
      pool.decrement(sheet);
      sheetIndex++;
    }
    const placedIds = new Set(finalized.map((p) => p.part.id));
    for (const p of group) if (!placedIds.has(p.id)) unplaced.push(p);
  }

  return buildNestingResult(
    sheets,
    restoreUnplaced(unplaced, originals),
    topLevelDimensions(sheets, primary),
  );
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
  const candidateSizes = availableSheets(input.config);
  const primary = candidateSizes[0];
  // The area lower bound is governed by the LARGEST available size (the fewest sheets any size
  // mix could need); the sweep's bin-area guard uses the same largest area.
  const largest = largestSheet(candidateSizes);
  const floor = sheetLowerBound(input.parts, input.quantities, largest);

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
      const sheetArea = largest.width * largest.height;
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

  return best ?? EMPTY_RESULT(primary);
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
