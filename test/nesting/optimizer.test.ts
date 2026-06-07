import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  optimize,
  optimizeIterative,
  hasStalled,
  fitnessFromStats,
  heuristicOrders,
  PENALTY_PER_UNPLACED,
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

// Convergence disarmed (stallWindow >= maxGenerations) so existing tests run a fixed count.
const fastConfig = {
  ...DEFAULT_OPTIMIZER_CONFIG,
  populationSize: 10,
  maxGenerations: 5,
  stallWindow: 5,
  stallEpsilon: 0.005,
};

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

  it('gives empty placement fitness == totalParts*PENALTY + 1 and finite (A1)', () => {
    const totalParts = 3;
    const f = fitnessFromStats({ openAreaRatio: 1, stripHeight: 0 }, totalParts, sheetHeight);
    // openAreaRatio default 1, stripHeight 0 ⇒ no tiebreak term.
    expect(f).toBe(totalParts * PENALTY_PER_UNPLACED + 1);
    expect(Number.isFinite(f)).toBe(true);
  });

  it('is finite when sheetHeight is 0 (divide-by-zero guard)', () => {
    const f = fitnessFromStats({ openAreaRatio: 0.5, stripHeight: 10 }, 0, 0);
    expect(f).toBe(0.5); // tiebreak term is 0 when sheetHeight is 0
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
    expect(calls.length).toBe(fastConfig.maxGenerations);
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
    expect(count).toBe(fastConfig.maxGenerations);
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

describe('hasStalled', () => {
  it('returns false when history is shorter than window + 1 (A8)', () => {
    // window 3 needs 4 entries; only 3 present
    expect(hasStalled([10, 9, 8], 3, 0.005)).toBe(false);
    // empty / single-entry histories
    expect(hasStalled([], 1, 0.005)).toBe(false);
    expect(hasStalled([5], 1, 0.005)).toBe(false);
  });

  it('returns true when relative improvement over the window < epsilon', () => {
    // prev = 100, curr = 100 -> improvement 0 < 0.005
    expect(hasStalled([100, 100, 100, 100, 100, 100], 5, 0.005)).toBe(true);
    // tiny improvement: 100 -> 99.99 over window => 0.0001 < 0.005
    expect(hasStalled([100, 100, 100, 100, 100, 99.99], 5, 0.005)).toBe(true);
  });

  it('returns false when improvement >= epsilon', () => {
    // prev = 100, curr = 90 over window 5 => 0.10 >= 0.005
    expect(hasStalled([100, 99, 97, 95, 92, 90], 5, 0.005)).toBe(false);
    // exactly equal to epsilon is not "< epsilon" => not stalled
    expect(hasStalled([100, 99.5], 1, 0.005)).toBe(false);
  });

  it('returns a defined boolean with no NaN/Infinity when windowed-back value is near zero (A6)', () => {
    const r = hasStalled([0, 0, 0], 2, 0.005);
    expect(typeof r).toBe('boolean');
    expect(Number.isNaN(r as unknown as number)).toBe(false);
    // zero history is fully stalled
    expect(r).toBe(true);
  });

  it('never reports stalled when epsilon <= 0', () => {
    expect(hasStalled([100, 100, 100], 2, 0)).toBe(false);
    expect(hasStalled([100, 100, 100], 2, -1)).toBe(false);
    // even a zero-history (improvement 0) is not < 0
    expect(hasStalled([0, 0, 0], 2, 0)).toBe(false);
  });
});

describe('optimizeIterative convergence', () => {
  // Stall-prone setup: small parts on a large sheet converge quickly.
  const stallParts = [makePart('a', 5, 5), makePart('b', 5, 5), makePart('c', 5, 5)];
  const sheet = { width: 100, height: 100 };

  it('stops before maxGenerations on a stalling case and returns a non-empty placement (A6, A9)', () => {
    const config = {
      ...DEFAULT_OPTIMIZER_CONFIG,
      populationSize: 10,
      maxGenerations: 50,
      stallWindow: 5,
      stallEpsilon: 0.01,
    };
    const gen = optimizeIterative(stallParts, sheet, 0, config);
    let count = 0;
    let result;
    let iter;
    do {
      iter = gen.next();
      if (!iter.done) {
        expect(iter.value).toHaveProperty('generation');
        expect(iter.value).toHaveProperty('bestFitness');
        expect(iter.value).toHaveProperty('bestPlacement');
        count++;
      } else {
        result = iter.value;
      }
    } while (!iter.done);

    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(config.maxGenerations);
    expect(Array.isArray(result)).toBe(true);
    expect(result!.length).toBeGreaterThan(0);
  });

  it('yields exactly maxGenerations values when convergence is disarmed (A7)', () => {
    const config = {
      ...DEFAULT_OPTIMIZER_CONFIG,
      populationSize: 10,
      maxGenerations: 12,
      stallWindow: 12, // >= maxGenerations => never triggers
      stallEpsilon: 0.5,
    };
    const gen = optimizeIterative(stallParts, sheet, 0, config);
    let count = 0;
    for (const progress of gen) {
      expect(progress).toHaveProperty('generation');
      expect(progress).toHaveProperty('bestFitness');
      expect(progress).toHaveProperty('bestPlacement');
      count++;
    }
    expect(count).toBe(config.maxGenerations);
  });
});

describe('heuristicOrders (pure)', () => {
  it('returns a biggest-area-first ordering and a tallest-first ordering (#13)', () => {
    // areas: a=100, b=2000, c=1200 ; heights: a=10, b=40, c=60
    const parts = [makePart('a', 10, 10), makePart('b', 50, 40), makePart('c', 20, 60)];
    const [byArea, byHeight] = heuristicOrders(parts);
    expect(byArea).toEqual([1, 2, 0]); // b, c, a by descending bbox area
    expect(byHeight).toEqual([2, 1, 0]); // c, b, a by descending height
  });

  it('returns permutations of all part indices', () => {
    const parts = [makePart('a', 5, 5), makePart('b', 6, 6), makePart('c', 7, 7)];
    for (const order of heuristicOrders(parts)) {
      expect([...order].sort((x, y) => x - y)).toEqual([0, 1, 2]);
    }
  });
});
