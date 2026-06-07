import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  nestParts,
  nestPartsIterative,
  computeMinimumSheet,
  makeOptimizerConfig,
} from '$lib/nesting/engine';
import { optimizeIterative } from '$lib/nesting/optimizer';
import { computeSheetStats, openAreaStats } from '$lib/nesting/stats';
import { bottomLeftFill } from '$lib/nesting/placement';
import type { Part, NestingConfig } from '$lib/geometry/types';

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

const fastConfig: NestingConfig = {
  sheet: { width: 100, height: 100 },
  kerf: 0,
  rotationSteps: 4,
  populationSize: 5,
  generations: 3,
  // Pin a small cap with convergence disarmed so fixed-count assertions hold.
  maxGenerations: 3,
  stallWindow: 3,
  stallEpsilon: 0.005,
};

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

describe('nestParts', () => {
  it('returns empty result for no parts', () => {
    const result = nestParts({ parts: [], quantities: new Map(), config: fastConfig });
    expect(result.sheets).toHaveLength(0);
    expect(result.totalPlaced).toBe(0);
  });

  it('nests a single part on one sheet', () => {
    const result = nestParts({
      parts: [makePart('a', 20, 10)],
      quantities: new Map([['a', 1]]),
      config: fastConfig,
    });
    expect(result.sheets).toHaveLength(1);
    expect(result.sheets[0].placed).toHaveLength(1);
    expect(result.totalPlaced).toBe(1);
  });

  it('expands quantities across sheets if needed', () => {
    // 5 copies of 60x60 on a 100x100 sheet = needs multiple sheets
    const result = nestParts({
      parts: [makePart('a', 60, 60)],
      quantities: new Map([['a', 5]]),
      config: fastConfig,
    });
    expect(result.sheets.length).toBeGreaterThan(1);
    expect(result.totalPlaced + result.unplaced.length).toBe(5);
  });

  it('places parts on single sheet when they fit', () => {
    const parts = [makePart('a', 15, 15), makePart('b', 10, 10)];
    const result = nestParts({
      parts,
      quantities: new Map([
        ['a', 2],
        ['b', 3],
      ]),
      config: fastConfig,
    });
    expect(result.totalPlaced).toBe(5);
  });

  it('reports per-sheet stats', () => {
    const result = nestParts({
      parts: [makePart('a', 50, 50)],
      quantities: new Map([['a', 1]]),
      config: fastConfig,
    });
    expect(result.sheets[0].stripHeight).toBeGreaterThan(0);
    expect(result.sheets[0].utilization).toBeGreaterThan(0);
    expect(result.sheets[0].utilization).toBeLessThanOrEqual(1);
  });

  it('uses default quantity of 1', () => {
    const result = nestParts({
      parts: [makePart('a', 10, 10)],
      quantities: new Map(),
      config: fastConfig,
    });
    expect(result.totalPlaced).toBe(1);
  });
});

describe('nestPartsIterative', () => {
  it('yields progress with sheet info', () => {
    const gen = nestPartsIterative({
      parts: [makePart('a', 10, 10)],
      quantities: new Map([['a', 1]]),
      config: fastConfig,
    });
    let count = 0;
    for (const progress of gen) {
      expect(progress).toHaveProperty('currentSheet');
      expect(progress).toHaveProperty('generation');
      expect(progress.result).toHaveProperty('sheets');
      count++;
    }
    expect(count).toBe(fastConfig.generations);
  });

  it('returns final multi-sheet result', () => {
    const gen = nestPartsIterative({
      parts: [makePart('a', 10, 10)],
      quantities: new Map([['a', 1]]),
      config: fastConfig,
    });
    let iter;
    do {
      iter = gen.next();
    } while (!iter.done);
    expect(iter.value.sheets).toHaveLength(1);
    expect(iter.value.totalPlaced).toBe(1);
  });
});

describe('makeOptimizerConfig', () => {
  const base: NestingConfig = {
    sheet: { width: 100, height: 100 },
    kerf: 0,
    rotationSteps: 8,
    populationSize: 20,
    generations: 50,
  };

  it('defaults omitted convergence fields (A10)', () => {
    const opt = makeOptimizerConfig(base);
    // maxGenerations = max(generations, 200)
    expect(opt.maxGenerations).toBe(200);
    expect(opt.stallWindow).toBe(15);
    expect(opt.stallEpsilon).toBe(0.005);
    // passthrough of existing fields
    expect(opt.populationSize).toBe(20);
    expect(opt.rotationSteps).toBe(8);
    expect(opt.mutationRate).toBe(0.3);
  });

  it('uses generations as the cap baseline when larger than 200', () => {
    const opt = makeOptimizerConfig({ ...base, generations: 500 });
    expect(opt.maxGenerations).toBe(500);
  });

  it('passes through provided convergence values (A10)', () => {
    const opt = makeOptimizerConfig({
      ...base,
      stallWindow: 7,
      stallEpsilon: 0.02,
      maxGenerations: 123,
    });
    expect(opt.maxGenerations).toBe(123);
    expect(opt.stallWindow).toBe(7);
    expect(opt.stallEpsilon).toBe(0.02);
  });

  it('handles partial overrides (A10)', () => {
    const opt = makeOptimizerConfig({ ...base, stallWindow: 3 });
    expect(opt.stallWindow).toBe(3);
    expect(opt.stallEpsilon).toBe(0.005);
    expect(opt.maxGenerations).toBe(200);
  });

  it('produces a terminating optimizer for degenerate configs (A10)', () => {
    const parts = [makePart('a', 5, 5), makePart('b', 5, 5)];
    const sheet = { width: 100, height: 100 };
    const degenerates: NestingConfig[] = [
      { ...base, generations: 5, stallWindow: 0, maxGenerations: 5 },
      { ...base, generations: 5, stallWindow: 1, maxGenerations: 5 },
      { ...base, generations: 5, stallWindow: 99, maxGenerations: 5 },
      { ...base, generations: 5, stallEpsilon: 0, maxGenerations: 5 },
      { ...base, generations: 5, stallEpsilon: -1, maxGenerations: 5 },
    ];
    for (const cfg of degenerates) {
      const opt = makeOptimizerConfig(cfg);
      const gen = optimizeIterative(parts, sheet, 0, opt);
      let count = 0;
      let iter;
      do {
        iter = gen.next();
        if (!iter.done) count++;
      } while (!iter.done);
      // Always terminates within maxGenerations and yields at least one progress value.
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(opt.maxGenerations);
    }
  });
});

describe('single source of truth (A12)', () => {
  it('computeSheetStats utilization equals 1 - openAreaStats openAreaRatio', () => {
    const sheet = fastConfig.sheet;
    const placed = bottomLeftFill(
      [
        { part: makePart('a', 50, 50), rotation: 0 },
        { part: makePart('b', 20, 20), rotation: 0 },
      ],
      sheet,
    );
    const computed = computeSheetStats(placed, sheet);
    const area = openAreaStats(placed, sheet);
    expect(computed.utilization).toBeCloseTo(1 - area.openAreaRatio);
  });
});

describe('computeMinimumSheet', () => {
  it('returns zeros for empty input', () => {
    const info = computeMinimumSheet([], new Map(), 0);
    expect(info.minWidth).toBe(0);
    expect(info.totalArea).toBe(0);
  });

  it('returns part dimensions for single part', () => {
    const info = computeMinimumSheet([makePart('a', 30, 50)], new Map([['a', 1]]), 0);
    expect(info.largestWidth).toBe(30);
    expect(info.largestHeight).toBe(50);
  });

  it('includes kerf in area calculation', () => {
    const withoutKerf = computeMinimumSheet([makePart('a', 10, 10)], new Map([['a', 1]]), 0);
    const withKerf = computeMinimumSheet([makePart('a', 10, 10)], new Map([['a', 1]]), 5);
    expect(withKerf.totalArea).toBeGreaterThan(withoutKerf.totalArea);
  });

  it('respects quantities', () => {
    const one = computeMinimumSheet([makePart('a', 10, 10)], new Map([['a', 1]]), 0);
    const three = computeMinimumSheet([makePart('a', 10, 10)], new Map([['a', 3]]), 0);
    expect(three.totalArea).toBeCloseTo(one.totalArea * 3);
  });
});
