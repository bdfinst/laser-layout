import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  nestParts,
  nestPartsIterative,
  computeMinimumSheet,
  makeOptimizerConfig,
  nestPartsMultiStart,
  isBetterResult,
  sheetLowerBound,
  type NestingResult,
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

  it('returns parts as unplaced when nothing fits on the sheet', () => {
    // 200x200 part on the 100x100 fastConfig sheet — cannot be placed.
    const result = nestParts({
      parts: [makePart('huge', 200, 200)],
      quantities: new Map([['huge', 1]]),
      config: fastConfig,
    });
    expect(result.sheets).toHaveLength(0);
    expect(result.totalPlaced).toBe(0);
    expect(result.unplaced).toHaveLength(1);
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
    const opt = makeOptimizerConfig(base); // generations: 50
    // maxGenerations = max(generations * 3, 120) = max(150, 120) = 150
    expect(opt.maxGenerations).toBe(150);
    expect(opt.stallWindow).toBe(15);
    expect(opt.stallEpsilon).toBe(0.005);
    // passthrough of existing fields
    expect(opt.populationSize).toBe(20);
    expect(opt.rotationSteps).toBe(8);
    expect(opt.mutationRate).toBe(0.3);
  });

  it('scales the cap 3x with generations', () => {
    const opt = makeOptimizerConfig({ ...base, generations: 500 });
    expect(opt.maxGenerations).toBe(1500);
  });

  it('applies the 120 floor for small generation budgets', () => {
    const opt = makeOptimizerConfig({ ...base, generations: 10 });
    expect(opt.maxGenerations).toBe(120); // max(30, 120)
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
    expect(opt.maxGenerations).toBe(150); // base.generations 50 → max(150, 120)
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

describe('multi-start helpers', () => {
  function result(
    unplaced: number,
    sheets: { stripHeight: number }[],
    sheetWidth = 100,
  ): NestingResult {
    return {
      sheets: sheets.map((s, i) => ({
        sheetIndex: i,
        placed: [],
        stripHeight: s.stripHeight,
        utilization: 0,
      })),
      unplaced: Array.from({ length: unplaced }, (_, i) => makePart(`u${i}`, 1, 1)),
      sheetWidth,
      sheetHeight: 100,
      totalPlaced: 0,
    };
  }

  describe('isBetterResult', () => {
    it('prefers fewer unplaced parts above all else', () => {
      const a = result(0, [{ stripHeight: 99 }, { stripHeight: 99 }]); // 0 unplaced, 2 sheets
      const b = result(1, [{ stripHeight: 1 }]); // 1 unplaced, 1 tiny sheet
      expect(isBetterResult(a, b)).toBe(true);
      expect(isBetterResult(b, a)).toBe(false);
    });

    it('prefers fewer sheets when unplaced ties', () => {
      const a = result(0, [{ stripHeight: 50 }]);
      const b = result(0, [{ stripHeight: 10 }, { stripHeight: 10 }]);
      expect(isBetterResult(a, b)).toBe(true);
    });

    it('prefers the denser pack (less used area) when unplaced and sheets tie', () => {
      const a = result(0, [{ stripHeight: 30 }]);
      const b = result(0, [{ stripHeight: 60 }]);
      expect(isBetterResult(a, b)).toBe(true);
      expect(isBetterResult(b, a)).toBe(false);
    });
  });

  describe('sheetLowerBound', () => {
    it('is 1 when all parts fit within a single sheet area', () => {
      const parts = [makePart('a', 10, 10), makePart('b', 20, 20)];
      const q = new Map([
        ['a', 1],
        ['b', 1],
      ]);
      expect(sheetLowerBound(parts, q, { width: 100, height: 100 })).toBe(1);
    });

    it('rises with total true area beyond one sheet', () => {
      // 3 parts of 80×80 = 19200 true area vs 100×100 sheet (10000) ⇒ ceil(1.92) = 2.
      const parts = [makePart('a', 80, 80)];
      const q = new Map([['a', 3]]);
      expect(sheetLowerBound(parts, q, { width: 100, height: 100 })).toBe(2);
    });
  });

  describe('nestPartsMultiStart', () => {
    it('places everything on one sheet for a job that fits, stopping at the area floor', () => {
      const input = {
        parts: [makePart('a', 20, 20), makePart('b', 20, 20)],
        quantities: new Map([
          ['a', 1],
          ['b', 1],
        ]),
        config: fastConfig,
      };
      const res = nestPartsMultiStart(input, { maxStarts: 50, timeBudgetMs: 60_000 });
      expect(res.unplaced).toHaveLength(0);
      expect(res.sheets).toHaveLength(1);
    });

    it('respects maxStarts and never returns a worse result than a single start', () => {
      const input = {
        parts: [makePart('a', 30, 30), makePart('b', 25, 25), makePart('c', 15, 15)],
        quantities: new Map([
          ['a', 1],
          ['b', 1],
          ['c', 1],
        ]),
        config: fastConfig,
      };
      const single = nestParts(input);
      const multi = nestPartsMultiStart(input, { maxStarts: 3, timeBudgetMs: 60_000 });
      // multi keeps the best across starts, so it is never strictly worse than one start.
      expect(isBetterResult(single, multi)).toBe(false);
    });

    it('stops immediately when the clock is already past the deadline (one start min)', () => {
      const input = {
        parts: [makePart('a', 10, 10)],
        quantities: new Map([['a', 1]]),
        config: fastConfig,
      };
      // now() always returns a time past the deadline ⇒ the do/while still runs exactly one start.
      const res = nestPartsMultiStart(input, { timeBudgetMs: 0, now: () => 1, maxStarts: 99 });
      expect(res.totalPlaced).toBe(1);
    });
  });
});
