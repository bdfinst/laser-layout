import type { Part, MaterialSheet, PlacedPart } from '$lib/geometry/types';
import { boundingBox } from '$lib/geometry/polygon';
import { bottomLeftFill } from './placement';
import { openAreaStats, gravityMetric, remnantStats } from './stats';
import { createNfpCache, type NfpCache } from './nfp-cache';

/**
 * Deterministic "biggest-first" seed orderings for the initial GA population.
 * Classic bottom-left-fill packs best when large parts are placed first, so seeding
 * the population with parts sorted by descending bounding-box area and by descending
 * height gives the GA strong starting points. Returns index permutations (rotation 0).
 */
export function heuristicOrders(parts: Part[]): number[][] {
  const dims = parts.map((p) => boundingBox(p.polygons[0]));
  const idx = Array.from({ length: parts.length }, (_, i) => i);
  const byArea = [...idx].sort(
    (a, b) => dims[b].width * dims[b].height - dims[a].width * dims[a].height,
  );
  const byHeight = [...idx].sort((a, b) => dims[b].height - dims[a].height);
  return [byArea, byHeight];
}

// Density-aware fitness (lower is better). Feasibility dominates: each unplaced part
// adds a heavy penalty that always outranks any open-area/strip difference. Open-area
// ratio (in [0,1]) is the primary in-region objective; strip height is a tiny tiebreaker.
export const PENALTY_PER_UNPLACED = 1000;
export const STRIP_TIEBREAK = 1e-3;

// Remnant-aware terms (#41). Both are small relative to openAreaRatio (range [0,1]) so
// the dominant density objective and feasibility are never overridden — they only break
// ties among comparably-dense layouts, nudging toward a clustered pack and one large
// reusable offcut. Tunable via OptimizerConfig.{gravityWeight,remnantWeight}.
export const GRAVITY_WEIGHT = 0.05;
export const REMNANT_WEIGHT = 0.05;

export interface FitnessStats {
  openAreaRatio: number;
  stripHeight: number;
  /** Compactness pull in [0,1] (lower is tighter). Omit to disable the gravity term. */
  gravity?: number;
  /** Largest reusable-offcut ratio in [0,1] (higher is better). Omit to disable the remnant term. */
  remnantRatio?: number;
}

export function fitnessFromStats(
  stats: FitnessStats,
  unplacedCount: number,
  sheetHeight: number,
  weights: { gravity?: number; remnant?: number } = {},
): number {
  const gravityWeight = weights.gravity ?? GRAVITY_WEIGHT;
  const remnantWeight = weights.remnant ?? REMNANT_WEIGHT;
  // Terms are opt-in by presence: when a metric is omitted its contribution is exactly 0,
  // so legacy callers (and the existing baselines) are byte-for-byte unchanged.
  const gravityTerm = stats.gravity === undefined ? 0 : gravityWeight * stats.gravity;
  const remnantTerm =
    stats.remnantRatio === undefined ? 0 : remnantWeight * (1 - stats.remnantRatio);
  return (
    unplacedCount * PENALTY_PER_UNPLACED +
    stats.openAreaRatio +
    gravityTerm +
    remnantTerm +
    STRIP_TIEBREAK * (sheetHeight > 0 ? stats.stripHeight / sheetHeight : 0)
  );
}

export interface OptimizerConfig {
  populationSize: number;
  maxGenerations: number; // hard safety cap on generations
  stallWindow: number; // generations without meaningful improvement before stopping
  stallEpsilon: number; // minimum relative improvement that counts as progress
  mutationRate: number;
  rotationSteps: number; // e.g. 360 means 1° increments
  useNfpPlacement?: boolean; // opt-in NFP placement path (epic #24, P3–P5); default off
  // Remnant-aware fitness weights (#41). Small by design; default to GRAVITY_WEIGHT /
  // REMNANT_WEIGHT. Set to 0 to disable a term without touching the rest of the fitness.
  gravityWeight?: number;
  remnantWeight?: number;
}

export const DEFAULT_OPTIMIZER_CONFIG: OptimizerConfig = {
  populationSize: 30,
  mutationRate: 0.3,
  rotationSteps: 72, // 5° increments
  maxGenerations: 200,
  stallWindow: 15,
  stallEpsilon: 0.005,
};

/**
 * Pure convergence check. Returns true when the best fitness has not improved
 * by at least `epsilon` (relative) over the last `window` generations.
 * Lower fitness is better. Deterministic — no GA, no RNG.
 */
export function hasStalled(history: number[], window: number, epsilon: number): boolean {
  if (history.length < window + 1) return false; // window guard (A8)
  const prev = history[history.length - 1 - window];
  const curr = history[history.length - 1];
  const denom = Math.max(Math.abs(prev), 1e-9); // divide-by-zero guard (A6)
  return (prev - curr) / denom < epsilon; // lower fitness is better
}

export interface Individual {
  rotations: number[]; // rotation angle in radians for each part
  order: number[]; // placement order (indices into parts array)
  mirrors: boolean[]; // reflection flag for each part (#15)
  fitness: number; // lower is better (open-area ratio + unplaced penalty)
  placement: PlacedPart[]; // cached result of the last evaluate() — reused for progress/return
}

function cloneIndividual(ind: Individual): Individual {
  return {
    rotations: [...ind.rotations],
    order: [...ind.order],
    mirrors: [...ind.mirrors],
    fitness: ind.fitness,
    placement: ind.placement,
  };
}

export interface PolishOptions {
  angleStep: number; // one rotation grid step in radians (jitter magnitude)
  maxPasses?: number; // safety cap on improvement sweeps (default 4)
  maxEvaluations?: number; // hard budget on candidate evaluations (default Infinity)
}

/**
 * Memetic local-search polish (#39). A deterministic hill-climb that squeezes the last
 * few percent out of the GA's best individual after it has converged. Each pass tries
 * two cheap neighbourhoods — every adjacent placement-order swap, then a ±1-step rotation
 * nudge on each part — and keeps a move only when `evaluateInd` reports a strictly lower
 * fitness. Because it never accepts a worse (or unplacing) move, the returned individual's
 * fitness is always ≤ the input's, so it can only improve or preserve density/feasibility.
 *
 * Uses no RNG, so it neither perturbs the GA's random stream nor changes existing
 * baselines — the GA runs identically and this only refines its final result. Stops as
 * soon as a full pass yields no improvement, or after `maxPasses`.
 *
 * `evaluateInd` must both score the individual and cache its `.placement` (the optimizer's
 * `evaluate` does), so the accepted individual carries the placement matching its genes.
 */
export function localSearchPolish(
  best: Individual,
  evaluateInd: (ind: Individual) => number,
  options: PolishOptions,
): Individual {
  const n = best.order.length;
  const maxPasses = options.maxPasses ?? 4;
  const maxEvaluations = options.maxEvaluations ?? Infinity;
  let evaluations = 0;
  let current = cloneIndividual(best);
  if (!Number.isFinite(current.fitness)) {
    current.fitness = evaluateInd(current);
    evaluations++;
  }

  // Returns 'improved' | 'kept' | 'budget' so the caller can stop the moment the
  // evaluation budget is spent. The budget bounds polish cost in NFP mode, where each
  // exact evaluation is ~35x the bbox cost.
  const tryMove = (mutateCandidate: (c: Individual) => void): 'improved' | 'kept' | 'budget' => {
    if (evaluations >= maxEvaluations) return 'budget';
    const candidate = cloneIndividual(current);
    mutateCandidate(candidate);
    const f = evaluateInd(candidate);
    evaluations++;
    if (f < current.fitness) {
      candidate.fitness = f; // evaluateInd cached candidate.placement
      current = candidate;
      return 'improved';
    }
    return 'kept';
  };

  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    let outOfBudget = false;

    // Neighbourhood 1: adjacent order swaps (cheap reordering of placement sequence).
    for (let i = 0; i + 1 < n && !outOfBudget; i++) {
      const r = tryMove((c) => {
        [c.order[i], c.order[i + 1]] = [c.order[i + 1], c.order[i]];
      });
      if (r === 'budget') outOfBudget = true;
      else if (r === 'improved') improved = true;
    }

    // Neighbourhood 2: small rotation jitter (±1 grid step) per part. Grain/lock clamps
    // are applied at consumption (toOrderedParts), so constrained parts stay legal.
    for (let i = 0; i < n && !outOfBudget; i++) {
      for (const delta of [options.angleStep, -options.angleStep]) {
        const r = tryMove((c) => {
          c.rotations[i] += delta;
        });
        if (r === 'budget') {
          outOfBudget = true;
          break;
        } else if (r === 'improved') improved = true;
      }
    }

    if (outOfBudget || !improved) break;
  }

  return current;
}

/**
 * Snap an arbitrary rotation to the nearest grain-allowed angle (0° or 180°). Grain /
 * directional materials may only be cut along the grain, so cross-grain rotations (90°,
 * 270°, …) are folded onto whichever of {0, π} is closest after normalizing to [0, 2π).
 */
export function snapToGrain(rotation: number): number {
  const TWO_PI = 2 * Math.PI;
  const r = ((rotation % TWO_PI) + TWO_PI) % TWO_PI; // normalize to [0, 2π)
  // Distance to 0 wraps around 2π, so compare against both ends and π.
  const toZero = Math.min(r, TWO_PI - r);
  const toPi = Math.abs(r - Math.PI);
  return toZero <= toPi ? 0 : Math.PI;
}

export function toOrderedParts(
  individual: Individual,
  parts: Part[],
): { part: Part; rotation: number; mirror: boolean }[] {
  return individual.order.map((idx, i) => ({
    part: parts[idx],
    // A grain-constrained part may only sit at 0°/180° (#43). Like the mirror clamp below,
    // this is a consumption-time snap keyed by part index, so it holds across every GA path
    // (random init, crossover, mutation, seeds) without constraining the rotation gene.
    rotation: parts[idx].grainConstraint
      ? snapToGrain(individual.rotations[i])
      : individual.rotations[i],
    // A locked part must never be mirrored, regardless of its mirror gene (#33).
    // Keyed by part index `idx` (not order position `i`), since lockOrientation is a
    // property of the part. This consumption-time clamp guarantees correctness across
    // every GA path (random init, crossover, mutation, all seeds and generations).
    mirror: parts[idx].lockOrientation ? false : individual.mirrors[i],
  }));
}

export interface OptimizeProgress {
  generation: number;
  bestFitness: number;
  bestPlacement: PlacedPart[];
}

/**
 * Genetic algorithm optimizer that searches for the best rotation angles
 * and placement order to minimize the strip height on the material.
 *
 * Returns a generator that yields after each generation so the caller
 * can update the UI between iterations.
 */
export function* optimizeIterative(
  parts: Part[],
  sheet: MaterialSheet,
  kerf: number = 0,
  config: OptimizerConfig = DEFAULT_OPTIMIZER_CONFIG,
): Generator<OptimizeProgress, PlacedPart[], void> {
  if (parts.length === 0) return [];

  const n = parts.length;
  const angleStep = (2 * Math.PI) / config.rotationSteps;

  // One NFP cache for the whole sheet (epic #24), only when the NFP placement path is
  // enabled. Translation-invariant and keyed by shape signature, so it amortizes across
  // every exact-phase evaluation; the fast phase never touches it. `null` ⇒ the legacy
  // placement path runs unchanged. Discarded with this generator when the sheet is done.
  const nfpCache: NfpCache | null = config.useNfpPlacement ? createNfpCache() : null;

  // Remnant-aware fitness weights (#41), resolved once and threaded to every evaluation.
  const gw = config.gravityWeight;
  const rw = config.remnantWeight;

  // Initialize population
  let population: Individual[] = [];
  for (let i = 0; i < config.populationSize; i++) {
    const individual = createRandomIndividual(n, angleStep, config.rotationSteps);
    individual.fitness = evaluate(individual, parts, sheet, kerf, false, nfpCache, gw, rw);
    population.push(individual);
  }

  // Also add a "no rotation" individual
  const noRotation: Individual = {
    rotations: new Array(n).fill(0),
    order: Array.from({ length: n }, (_, i) => i),
    mirrors: new Array(n).fill(false),
    fitness: 0,
    placement: [],
  };
  noRotation.fitness = evaluate(noRotation, parts, sheet, kerf, false, nfpCache, gw, rw);
  population[0] = noRotation;

  // Seed a few individuals with biggest-first heuristic orderings (#13).
  const seeds = heuristicOrders(parts);
  for (let s = 0; s < seeds.length && s + 1 < config.populationSize; s++) {
    const seeded: Individual = {
      rotations: new Array(n).fill(0),
      order: seeds[s],
      mirrors: new Array(n).fill(false),
      fitness: 0,
      placement: [],
    };
    seeded.fitness = evaluate(seeded, parts, sheet, kerf, false, nfpCache, gw, rw);
    population[s + 1] = seeded;
  }

  // Sort initial population
  population.sort((a, b) => a.fitness - b.fitness);

  // Two-phase evolution (#19). The exact true-shape collision (#11/#12) that makes packing
  // tight is ~35x costlier than the bbox approximation, so running it on every evaluation of
  // the broad search is too slow. Instead: search with FAST (bbox) collision until it
  // converges, then spend a short tail of generations refining with EXACT collision — long
  // enough for the GA to discover interlocking placements, cheap enough to stay fast. Total
  // generations stay bounded by maxGenerations.
  const eliteCount = Math.max(1, Math.floor(config.populationSize * 0.1));
  // Exact (true-shape / NFP) refinement is where density is won. Normally it's a short,
  // capped tail (the exact phase is costly). In density mode (NFP placement on) the app
  // trades time for density, so spend a third of the budget refining with NFP rather than
  // the ~12-generation cap — bounded overall by the worker's wall-clock budget.
  const exactBudget = config.useNfpPlacement
    ? Math.max(1, Math.floor(config.maxGenerations / 3))
    : Math.max(1, Math.min(12, Math.floor(config.maxGenerations / 4)));
  const fastCap = config.maxGenerations - exactBudget;
  const history: number[] = [];
  let exact = false;
  let exactGens = 0;
  let gen = 0;

  while (true) {
    const nextGen: Individual[] = [];
    for (let i = 0; i < eliteCount; i++) nextGen.push(population[i]);

    while (nextGen.length < config.populationSize) {
      const parent1 = tournamentSelect(population);
      const parent2 = tournamentSelect(population);
      let child = crossover(parent1, parent2, n);
      if (Math.random() < config.mutationRate) {
        child = mutate(child, angleStep, config.rotationSteps);
      }
      child.fitness = evaluate(child, parts, sheet, kerf, exact, nfpCache, gw, rw);
      nextGen.push(child);
    }

    population = nextGen;
    population.sort((a, b) => a.fitness - b.fitness);

    const best = population[0];
    // best.placement was cached by evaluate() in the current collision mode.
    yield { generation: gen, bestFitness: best.fitness, bestPlacement: best.placement };
    gen++;
    history.push(best.fitness);

    if (!exact) {
      if (hasStalled(history, config.stallWindow, config.stallEpsilon) || gen >= fastCap) {
        // Switch to exact refinement: re-score the whole population with true-shape
        // collision so fitness is comparable, then reset the stall window.
        for (const ind of population)
          ind.fitness = evaluate(ind, parts, sheet, kerf, true, nfpCache, gw, rw);
        population.sort((a, b) => a.fitness - b.fitness);
        exact = true;
        history.length = 0;
      }
    } else {
      exactGens++;
      if (
        exactGens >= exactBudget ||
        hasStalled(history, config.stallWindow, config.stallEpsilon)
      ) {
        break;
      }
    }
  }

  // population[0] was scored with exact collision; its cached placement is the tight result.
  // Memetic polish (#39): a deterministic hill-climb refines that champion with exact
  // collision before returning. It only accepts strict improvements, so the result is never
  // worse than the GA's best.
  // Keep polish cheap in NFP mode (each exact evaluation is ~35x the bbox cost) and let it
  // run more freely on the default true-shape path. Always bounded so it can't balloon.
  const polishBudget = config.useNfpPlacement ? 12 : 150;
  const polished = localSearchPolish(
    population[0],
    (ind) => evaluate(ind, parts, sheet, kerf, true, nfpCache, gw, rw),
    { angleStep, maxEvaluations: polishBudget },
  );
  return polished.placement;
}

/**
 * Synchronous optimize (used by tests).
 */
export function optimize(
  parts: Part[],
  sheet: MaterialSheet,
  kerf: number = 0,
  config: OptimizerConfig = DEFAULT_OPTIMIZER_CONFIG,
  onProgress?: (generation: number, bestFitness: number) => void,
): PlacedPart[] {
  const gen = optimizeIterative(parts, sheet, kerf, config);
  let last: IteratorResult<OptimizeProgress, PlacedPart[]>;
  do {
    last = gen.next();
    if (!last.done && onProgress) {
      onProgress(last.value.generation, last.value.bestFitness);
    }
  } while (!last.done);
  return last.value;
}

function createRandomIndividual(n: number, angleStep: number, rotationSteps: number): Individual {
  const rotations: number[] = [];
  for (let i = 0; i < n; i++) {
    const step = Math.floor(Math.random() * rotationSteps);
    rotations.push(step * angleStep);
  }

  // Random order using Fisher-Yates shuffle
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const mirrors = Array.from({ length: n }, () => Math.random() < 0.5);

  return { rotations, order, mirrors, fitness: Infinity, placement: [] };
}

function evaluate(
  individual: Individual,
  parts: Part[],
  sheet: MaterialSheet,
  kerf: number,
  exact: boolean,
  nfpCache: NfpCache | null = null,
  gravityWeight?: number,
  remnantWeight?: number,
): number {
  const placed = bottomLeftFill(toOrderedParts(individual, parts), sheet, kerf, exact, nfpCache);
  individual.placement = placed; // cache for progress reporting
  const stats = openAreaStats(placed, sheet);
  const unplacedCount = parts.length - placed.length;

  // Remnant-aware terms (#41): nudge toward a clustered pack with one large reusable
  // offcut. Both default-weighted small so density/feasibility stay dominant.
  const gravity = gravityMetric(placed, sheet);
  const remnantRatio = remnantStats(placed, sheet).largestRectRatio;

  return fitnessFromStats({ ...stats, gravity, remnantRatio }, unplacedCount, sheet.height, {
    gravity: gravityWeight,
    remnant: remnantWeight,
  });
}

function tournamentSelect(population: Individual[], size: number = 3): Individual {
  let best: Individual | null = null;
  for (let i = 0; i < size; i++) {
    const idx = Math.floor(Math.random() * population.length);
    if (!best || population[idx].fitness < best.fitness) {
      best = population[idx];
    }
  }
  return best!;
}

function crossover(parent1: Individual, parent2: Individual, n: number): Individual {
  // Uniform crossover for rotations
  const rotations = parent1.rotations.map((r, i) =>
    Math.random() < 0.5 ? r : parent2.rotations[i],
  );

  // Uniform crossover for mirror flags (by position, like rotations)
  const mirrors = parent1.mirrors.map((m, i) => (Math.random() < 0.5 ? m : parent2.mirrors[i]));

  // Order crossover (OX) for placement order
  const order = orderCrossover(parent1.order, parent2.order, n);

  return { rotations, order, mirrors, fitness: Infinity, placement: [] };
}

function orderCrossover(p1: number[], p2: number[], n: number): number[] {
  const start = Math.floor(Math.random() * n);
  const end = start + Math.floor(Math.random() * (n - start));

  const child = new Array(n).fill(-1);

  // Copy segment from parent 1
  for (let i = start; i <= end; i++) {
    child[i] = p1[i];
  }

  // Fill remaining from parent 2
  const used = new Set(child.filter((x) => x !== -1));
  let pos = (end + 1) % n;
  for (let i = 0; i < n; i++) {
    const idx = (end + 1 + i) % n;
    const val = p2[idx];
    if (!used.has(val)) {
      child[pos] = val;
      pos = (pos + 1) % n;
    }
  }

  return child;
}

function mutate(individual: Individual, angleStep: number, rotationSteps: number): Individual {
  const rotations = [...individual.rotations];
  const order = [...individual.order];
  const mirrors = [...individual.mirrors];
  const n = rotations.length;

  // Mutate rotation of a random part
  const rotIdx = Math.floor(Math.random() * n);
  const step = Math.floor(Math.random() * rotationSteps);
  rotations[rotIdx] = step * angleStep;

  // Flip the mirror flag of a random part (#15)
  const mirIdx = Math.floor(Math.random() * n);
  mirrors[mirIdx] = !mirrors[mirIdx];

  // Swap two random positions in order
  if (n > 1) {
    const i = Math.floor(Math.random() * n);
    let j = Math.floor(Math.random() * (n - 1));
    if (j >= i) j++;
    [order[i], order[j]] = [order[j], order[i]];
  }

  return { rotations, order, mirrors, fitness: Infinity, placement: [] };
}
