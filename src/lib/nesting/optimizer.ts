import type { Part, MaterialSheet, PlacedPart } from '$lib/geometry/types';
import { boundingBox } from '$lib/geometry/polygon';
import { bottomLeftFill } from './placement';
import { openAreaStats } from './stats';

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

export function fitnessFromStats(
  stats: { openAreaRatio: number; stripHeight: number },
  unplacedCount: number,
  sheetHeight: number,
): number {
  return (
    unplacedCount * PENALTY_PER_UNPLACED +
    stats.openAreaRatio +
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

interface Individual {
  rotations: number[]; // rotation angle in radians for each part
  order: number[]; // placement order (indices into parts array)
  fitness: number; // lower is better (open-area ratio + unplaced penalty)
  placement: PlacedPart[]; // cached result of the last evaluate() — reused for progress/return
}

function toOrderedParts(individual: Individual, parts: Part[]): { part: Part; rotation: number }[] {
  return individual.order.map((idx, i) => ({
    part: parts[idx],
    rotation: individual.rotations[i],
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

  // Initialize population
  let population: Individual[] = [];
  for (let i = 0; i < config.populationSize; i++) {
    const individual = createRandomIndividual(n, angleStep, config.rotationSteps);
    individual.fitness = evaluate(individual, parts, sheet, kerf);
    population.push(individual);
  }

  // Also add a "no rotation" individual
  const noRotation: Individual = {
    rotations: new Array(n).fill(0),
    order: Array.from({ length: n }, (_, i) => i),
    fitness: 0,
    placement: [],
  };
  noRotation.fitness = evaluate(noRotation, parts, sheet, kerf);
  population[0] = noRotation;

  // Seed a few individuals with biggest-first heuristic orderings (#13).
  const seeds = heuristicOrders(parts);
  for (let s = 0; s < seeds.length && s + 1 < config.populationSize; s++) {
    const seeded: Individual = {
      rotations: new Array(n).fill(0),
      order: seeds[s],
      fitness: 0,
      placement: [],
    };
    seeded.fitness = evaluate(seeded, parts, sheet, kerf);
    population[s + 1] = seeded;
  }

  // Sort initial population
  population.sort((a, b) => a.fitness - b.fitness);

  // Evolve, stopping early when best fitness converges (bounded by the safety cap).
  const history: number[] = [];
  for (let gen = 0; gen < config.maxGenerations; gen++) {
    const nextGen: Individual[] = [];

    // Elitism: keep top 10% (population is already sorted)
    const eliteCount = Math.max(1, Math.floor(config.populationSize * 0.1));
    for (let i = 0; i < eliteCount; i++) {
      nextGen.push(population[i]);
    }

    // Fill rest with crossover + mutation
    while (nextGen.length < config.populationSize) {
      const parent1 = tournamentSelect(population);
      const parent2 = tournamentSelect(population);
      let child = crossover(parent1, parent2, n);

      if (Math.random() < config.mutationRate) {
        child = mutate(child, angleStep, config.rotationSteps);
      }

      child.fitness = evaluate(child, parts, sheet, kerf);
      nextGen.push(child);
    }

    population = nextGen;
    population.sort((a, b) => a.fitness - b.fitness);

    const best = population[0];
    // best.placement was cached by evaluate() — no need to re-run bottomLeftFill here.
    yield { generation: gen, bestFitness: best.fitness, bestPlacement: best.placement };

    history.push(best.fitness);
    if (hasStalled(history, config.stallWindow, config.stallEpsilon)) break;
  }

  // Population is already sorted from the last iteration
  return population[0].placement;
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

  return { rotations, order, fitness: Infinity, placement: [] };
}

function evaluate(
  individual: Individual,
  parts: Part[],
  sheet: MaterialSheet,
  kerf: number,
): number {
  const placed = bottomLeftFill(toOrderedParts(individual, parts), sheet, kerf);
  individual.placement = placed; // cache for progress reporting / final return
  const stats = openAreaStats(placed, sheet);
  const unplacedCount = parts.length - placed.length;

  return fitnessFromStats(stats, unplacedCount, sheet.height);
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

  // Order crossover (OX) for placement order
  const order = orderCrossover(parent1.order, parent2.order, n);

  return { rotations, order, fitness: Infinity, placement: [] };
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
  const n = rotations.length;

  // Mutate rotation of a random part
  const rotIdx = Math.floor(Math.random() * n);
  const step = Math.floor(Math.random() * rotationSteps);
  rotations[rotIdx] = step * angleStep;

  // Swap two random positions in order
  if (n > 1) {
    const i = Math.floor(Math.random() * n);
    let j = Math.floor(Math.random() * (n - 1));
    if (j >= i) j++;
    [order[i], order[j]] = [order[j], order[i]];
  }

  return { rotations, order, fitness: Infinity, placement: [] };
}
