import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  optimize,
  optimizeIterative,
  fitnessFromStats,
  DEFAULT_OPTIMIZER_CONFIG,
} from '$lib/nesting/optimizer';
import type { Part } from '$lib/geometry/types';

function makePart(id: string, w: number, h: number): Part {
  return {
    id,
    name: id,
    polygons: [
      [
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: h },
        { x: 0, y: h },
      ],
    ],
    sourceIndex: 0,
  };
}

const fastConfig = { ...DEFAULT_OPTIMIZER_CONFIG, populationSize: 10, generations: 5 };

// Seed Math.random for deterministic tests
let origRandom: () => number;
beforeEach(() => {
  origRandom = Math.random;
  let seed = 42;
  Math.random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
});
afterEach(() => {
  Math.random = origRandom;
});

describe('fitnessFromStats (pure)', () => {
  const sheetHeight = 100;

  it('ranks the denser layout (lower openAreaRatio) better for equal unplaced/strip', () => {
    const dense = fitnessFromStats({ openAreaRatio: 0.2, stripHeight: 50 }, 0, sheetHeight);
    const gappy = fitnessFromStats({ openAreaRatio: 0.6, stripHeight: 50 }, 0, sheetHeight);
    expect(dense).toBeLessThan(gappy);
  });

  it('makes any unplaced layout worse than an all-placed one regardless of density (A2)', () => {
    // all placed but very gappy
    const allPlaced = fitnessFromStats({ openAreaRatio: 1, stripHeight: 100 }, 0, sheetHeight);
    // one unplaced but perfectly dense
    const oneUnplaced = fitnessFromStats({ openAreaRatio: 0, stripHeight: 0 }, 1, sheetHeight);
    expect(oneUnplaced).toBeGreaterThan(allPlaced);
  });

  it('breaks ties by strip height when density and unplaced are equal (tiebreak)', () => {
    const shorter = fitnessFromStats({ openAreaRatio: 0.4, stripHeight: 30 }, 0, sheetHeight);
    const taller = fitnessFromStats({ openAreaRatio: 0.4, stripHeight: 80 }, 0, sheetHeight);
    expect(shorter).toBeLessThan(taller);
  });

  it('gives empty placement fitness == totalParts*1000 + 1 and finite (A1)', () => {
    const totalParts = 3;
    const f = fitnessFromStats({ openAreaRatio: 1, stripHeight: 0 }, totalParts, sheetHeight);
    expect(f).toBe(totalParts * 1000 + 1);
    expect(Number.isFinite(f)).toBe(true);
  });
});

describe('optimize', () => {
  it('returns empty for empty input', () => {
    const result = optimize([], { width: 100, height: 100 }, 0, fastConfig);
    expect(result).toHaveLength(0);
  });

  it('places a single part', () => {
    const result = optimize([makePart('a', 20, 10)], { width: 100, height: 100 }, 0, fastConfig);
    expect(result).toHaveLength(1);
  });

  it('places multiple parts', () => {
    const result = optimize(
      [makePart('a', 30, 30), makePart('b', 20, 20), makePart('c', 15, 15)],
      { width: 100, height: 100 },
      0,
      fastConfig,
    );
    expect(result).toHaveLength(3);
  });

  it('respects kerf spacing', () => {
    const result = optimize(
      [makePart('a', 10, 10), makePart('b', 10, 10)],
      { width: 100, height: 100 },
      5,
      fastConfig,
    );
    expect(result).toHaveLength(2);
  });

  it('calls progress callback with finite fitness', () => {
    const calls: { gen: number; fitness: number }[] = [];
    optimize(
      [makePart('a', 10, 10)],
      { width: 100, height: 100 },
      0,
      fastConfig,
      (gen, fitness) => {
        calls.push({ gen, fitness });
      },
    );
    expect(calls.length).toBe(fastConfig.generations);
    for (const c of calls) {
      expect(Number.isFinite(c.fitness)).toBe(true);
    }
  });
});

describe('optimizeIterative', () => {
  it('yields one result per generation', () => {
    const gen = optimizeIterative(
      [makePart('a', 10, 10)],
      { width: 100, height: 100 },
      0,
      fastConfig,
    );
    let count = 0;
    for (const progress of gen) {
      expect(progress).toHaveProperty('generation');
      expect(progress).toHaveProperty('bestFitness');
      expect(progress).toHaveProperty('bestPlacement');
      expect(Number.isFinite(progress.bestFitness)).toBe(true);
      count++;
    }
    expect(count).toBe(fastConfig.generations);
  });

  it('returns final placement from generator return value', () => {
    const gen = optimizeIterative(
      [makePart('a', 10, 10)],
      { width: 100, height: 100 },
      0,
      fastConfig,
    );
    let result;
    let iter;
    do {
      iter = gen.next();
      if (iter.done) result = iter.value;
    } while (!iter.done);
    expect(Array.isArray(result)).toBe(true);
    expect(result!.length).toBe(1);
  });
});
