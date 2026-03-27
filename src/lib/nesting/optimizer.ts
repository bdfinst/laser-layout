import type { Part, MaterialSheet, PlacedPart } from '$lib/geometry/types';
import { bottomLeftFill, getStripHeight } from './placement';

export interface OptimizerConfig {
	populationSize: number;
	generations: number;
	mutationRate: number;
	rotationSteps: number; // e.g. 360 means 1° increments
}

export const DEFAULT_OPTIMIZER_CONFIG: OptimizerConfig = {
	populationSize: 30,
	generations: 50,
	mutationRate: 0.3,
	rotationSteps: 72 // 5° increments
};

interface Individual {
	rotations: number[]; // rotation angle in radians for each part
	order: number[]; // placement order (indices into parts array)
	fitness: number; // lower is better (strip height)
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
	config: OptimizerConfig = DEFAULT_OPTIMIZER_CONFIG
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
		fitness: 0
	};
	noRotation.fitness = evaluate(noRotation, parts, sheet, kerf);
	population[0] = noRotation;

	// Sort initial population
	population.sort((a, b) => a.fitness - b.fitness);

	// Evolve
	for (let gen = 0; gen < config.generations; gen++) {
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
		const bestPlacement = placementFromIndividual(best, parts, sheet, kerf);
		yield { generation: gen, bestFitness: best.fitness, bestPlacement };
	}

	// Population is already sorted from the last iteration
	return placementFromIndividual(population[0], parts, sheet, kerf);
}

/**
 * Synchronous optimize (used by tests).
 */
export function optimize(
	parts: Part[],
	sheet: MaterialSheet,
	kerf: number = 0,
	config: OptimizerConfig = DEFAULT_OPTIMIZER_CONFIG,
	onProgress?: (generation: number, bestFitness: number) => void
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

function placementFromIndividual(
	individual: Individual,
	parts: Part[],
	sheet: MaterialSheet,
	kerf: number
): PlacedPart[] {
	const orderedParts = individual.order.map((idx, i) => ({
		part: parts[idx],
		rotation: individual.rotations[i]
	}));
	return bottomLeftFill(orderedParts, sheet, kerf);
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

	return { rotations, order, fitness: Infinity };
}

function evaluate(
	individual: Individual,
	parts: Part[],
	sheet: MaterialSheet,
	kerf: number
): number {
	const orderedParts = individual.order.map((idx, i) => ({
		part: parts[idx],
		rotation: individual.rotations[i]
	}));

	const placed = bottomLeftFill(orderedParts, sheet, kerf);

	// Penalize unplaced parts heavily
	const unplacedPenalty = (parts.length - placed.length) * sheet.height;

	return getStripHeight(placed) + unplacedPenalty;
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
		Math.random() < 0.5 ? r : parent2.rotations[i]
	);

	// Order crossover (OX) for placement order
	const order = orderCrossover(parent1.order, parent2.order, n);

	return { rotations, order, fitness: Infinity };
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

	return { rotations, order, fitness: Infinity };
}
