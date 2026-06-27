import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  nestParts,
  nestPartsIterative,
  computeMinimumSheet,
  makeOptimizerConfig,
  nestPartsMultiStart,
  isBetterResult,
  isOptimalResult,
  resolveTimeBudget,
  sheetLowerBound,
  partitionByArea,
  packIntoKSheets,
  selectSheetForNextOpen,
  type NestingResult,
} from '$lib/nesting/engine';
import { optimizeIterative } from '$lib/nesting/optimizer';
import { computeSheetStats, openAreaStats, sharedEdgeLength } from '$lib/nesting/stats';
import { bottomLeftFill } from '$lib/nesting/placement';
import { makeRect as makePart } from '../support/parts';
import { seedRandom, restoreRandom } from '../support/seeded-random';
import { availableSheets, type NestingConfig } from '$lib/geometry/types';

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

beforeEach(() => seedRandom());
afterEach(() => restoreRandom());

describe('global multi-sheet assignment (#16)', () => {
  // Full-width parts reduce nesting to 1D height bin-packing. With kerf=1, no two of these
  // stack within 100mm except {48,48}, {52,40}, {40,48}; the 60 can never share a sheet.
  // Optimal is 4 sheets: {60} {52,40} {52} {48,48}. Greedy fill-then-overflow strands them
  // into 5; a balanced partition recovers the 4-sheet packing.
  const heights = [60, 52, 52, 48, 48, 40];
  const parts = heights.map((h, i) => makePart(`p${i}`, 100, h));
  const quantities = new Map(parts.map((p) => [p.id, 1]));
  const cfg: NestingConfig = {
    sheet: { width: 100, height: 100 },
    kerf: 1,
    rotationSteps: 4,
    populationSize: 20,
    generations: 30,
    maxGenerations: 60,
    stallWindow: 12,
    stallEpsilon: 0.005,
  };

  it('partitionByArea returns k groups containing every part, balanced by area', () => {
    const groups = partitionByArea(parts, 4);
    expect(groups).toHaveLength(4);
    const ids = groups
      .flat()
      .map((p) => p.id)
      .sort();
    expect(ids).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5'].sort());
    // The largest part (p0=60) seeds its own bin; no bin should be empty for k<=n.
    expect(groups.every((g) => g.length >= 1)).toBe(true);
  });

  it('pads with empty groups when k exceeds the part count', () => {
    const groups = partitionByArea(parts.slice(0, 2), 5);
    expect(groups).toHaveLength(5);
    expect(groups.flat()).toHaveLength(2);
    expect(groups.filter((g) => g.length === 0)).toHaveLength(3);
  });

  it('packs into fewer sheets than greedy via balanced assignment', () => {
    const originals = new Map(parts.map((p) => [p.id, p]));
    const greedy = nestParts({ parts, quantities, config: cfg });
    expect(greedy.unplaced).toHaveLength(0);

    const balanced = packIntoKSheets(parts, originals, cfg, 4);
    expect(balanced.unplaced).toHaveLength(0);
    expect(balanced.sheets.length).toBe(4);
    // The whole point: balanced uses strictly fewer sheets than greedy fill-then-overflow.
    expect(balanced.sheets.length).toBeLessThan(greedy.sheets.length);
  });

  it('multi-start adopts the fewer-sheet global assignment, never more', () => {
    const greedy = nestParts({ parts, quantities, config: cfg });
    const multi = nestPartsMultiStart({ parts, quantities, config: cfg }, { maxStarts: 3 });
    expect(multi.unplaced).toHaveLength(0);
    expect(multi.sheets.length).toBeLessThanOrEqual(greedy.sheets.length);
    expect(multi.sheets.length).toBe(4);
    // Every part still placed (no silent drops) — totalPlaced equals the input count.
    expect(multi.totalPlaced).toBe(parts.length);
  });

  it('does not increase sheet count when greedy is already optimal', () => {
    // Two parts that each need their own sheet: greedy and global both use 2.
    const big = [makePart('a', 100, 80), makePart('b', 100, 80)];
    const q = new Map(big.map((p) => [p.id, 1]));
    const greedy = nestParts({ parts: big, quantities: q, config: cfg });
    const multi = nestPartsMultiStart({ parts: big, quantities: q, config: cfg }, { maxStarts: 2 });
    expect(multi.sheets.length).toBe(greedy.sheets.length);
    expect(multi.unplaced).toHaveLength(0);
  });
});

describe('common-line cutting (#43)', () => {
  // Two identical squares on a roomy sheet. With a kerf gap and no common-line cutting they
  // sit apart; with common-line cutting the clearance drops to 0 and the GA reward drives
  // them edge-to-edge, producing genuine shared boundary.
  const parts = [makePart('a', 20, 20), makePart('b', 20, 20)];
  const quantities = new Map([
    ['a', 1],
    ['b', 1],
  ]);
  const clcConfig: NestingConfig = {
    sheet: { width: 100, height: 100 },
    kerf: 2,
    rotationSteps: 4,
    populationSize: 8,
    generations: 10,
    maxGenerations: 10,
    stallWindow: 10,
    stallEpsilon: 0.005,
  };

  it('places both parts whether or not common-line cutting is enabled', () => {
    const off = nestParts({ parts, quantities, config: clcConfig });
    const on = nestParts({ parts, quantities, config: { ...clcConfig, commonLineCutting: true } });
    expect(off.totalPlaced).toBe(2);
    expect(on.totalPlaced).toBe(2);
  });

  it('produces shared edges when enabled and none when the kerf gap is enforced', () => {
    const off = nestParts({ parts, quantities, config: clcConfig });
    const on = nestParts({ parts, quantities, config: { ...clcConfig, commonLineCutting: true } });
    // Kerf 2 keeps a gap → no coincident edges on the default path.
    expect(sharedEdgeLength(off.sheets[0].placed)).toBe(0);
    // Common-line cutting abuts the squares → a full 20mm shared edge.
    expect(sharedEdgeLength(on.sheets[0].placed)).toBeGreaterThan(0);
  });
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
        sheetWidth,
        sheetHeight: 100,
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

  describe('resolveTimeBudget', () => {
    it('uses the override, then config, then the default', () => {
      const cfg = { ...fastConfig, timeBudgetMs: 5000 };
      expect(resolveTimeBudget(cfg, 123)).toBe(123);
      expect(resolveTimeBudget(cfg)).toBe(5000);
      expect(resolveTimeBudget({ ...fastConfig, timeBudgetMs: undefined })).toBe(60_000);
      expect(resolveTimeBudget({ ...fastConfig, timeBudgetMs: 0 })).toBe(60_000);
    });
  });

  describe('isOptimalResult', () => {
    it('is true only when nothing is unplaced and sheets are at the floor', () => {
      expect(isOptimalResult(result(0, [{ stripHeight: 10 }]), 1)).toBe(true);
      expect(isOptimalResult(result(1, [{ stripHeight: 10 }]), 1)).toBe(false); // unplaced
      expect(isOptimalResult(result(0, [{ stripHeight: 5 }, { stripHeight: 5 }]), 1)).toBe(false); // 2 > floor 1
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

describe('least-committed-area objective (Slice 2)', () => {
  // Build a result with explicit per-sheet dimensions + strip heights so the comparator can be
  // exercised deterministically without running the GA.
  function makeResult(opts: {
    unplaced?: number;
    sheets: { stripHeight: number; w: number; h: number }[];
  }): NestingResult {
    const sheets = opts.sheets.map((s, i) => ({
      sheetIndex: i,
      placed: [],
      stripHeight: s.stripHeight,
      utilization: 0,
      sheetWidth: s.w,
      sheetHeight: s.h,
    }));
    return {
      sheets,
      unplaced: Array.from({ length: opts.unplaced ?? 0 }, (_, i) => makePart(`u${i}`, 1, 1)),
      sheetWidth: sheets[0]?.sheetWidth ?? 0,
      sheetHeight: sheets[0]?.sheetHeight ?? 0,
      totalPlaced: 0,
    };
  }

  it('prefers lower committed area even when it uses more sheets', () => {
    // A: two 50×50 sheets ⇒ committed 5000 over 2 sheets.
    // B: one 100×100 sheet ⇒ committed 10000 over 1 sheet.
    const a = makeResult({
      sheets: [
        { stripHeight: 50, w: 50, h: 50 },
        { stripHeight: 50, w: 50, h: 50 },
      ],
    });
    const b = makeResult({ sheets: [{ stripHeight: 100, w: 100, h: 100 }] });
    expect(isBetterResult(a, b)).toBe(true);
    expect(isBetterResult(b, a)).toBe(false);
  });

  it('breaks an equal-committed-area tie by fewer sheets', () => {
    // A: one 100×100 ⇒ committed 10000, 1 sheet.
    // B: two 100×50 ⇒ committed 10000, 2 sheets.
    const a = makeResult({ sheets: [{ stripHeight: 100, w: 100, h: 100 }] });
    const b = makeResult({
      sheets: [
        { stripHeight: 50, w: 100, h: 50 },
        { stripHeight: 50, w: 100, h: 50 },
      ],
    });
    expect(isBetterResult(a, b)).toBe(true);
    expect(isBetterResult(b, a)).toBe(false);
  });

  it('breaks an equal-area equal-count tie by less total strip area', () => {
    // Same committed area (10000) and sheet count (1); A packs into less strip height.
    const a = makeResult({ sheets: [{ stripHeight: 30, w: 100, h: 100 }] });
    const b = makeResult({ sheets: [{ stripHeight: 60, w: 100, h: 100 }] });
    expect(isBetterResult(a, b)).toBe(true);
    expect(isBetterResult(b, a)).toBe(false);
  });

  it('strip tie-break uses each sheet own width, not the result-level default', () => {
    // Two mixed-size sheets, equal committed area (8000+8000 vs 8000+8000) and equal count.
    // A's slack lands on the wide sheet (low strip) where B's lands on the narrow one — the
    // total strip AREA must be computed per-sheet, so A (less strip area) wins.
    const a = makeResult({
      sheets: [
        { stripHeight: 10, w: 200, h: 40 }, // strip area 2000
        { stripHeight: 40, w: 50, h: 160 }, // strip area 2000
      ],
    });
    const b = makeResult({
      sheets: [
        { stripHeight: 40, w: 200, h: 40 }, // strip area 8000
        { stripHeight: 10, w: 50, h: 160 }, // strip area 500
      ],
    });
    // committed identical (8000+8000 both); count identical (2). A strip area 4000 < B 8500.
    expect(isBetterResult(a, b)).toBe(true);
    expect(isBetterResult(b, a)).toBe(false);
  });

  it('matches the prior feasibility→fewer-sheets→density ordering for homogeneous jobs', () => {
    // Reference: the comparator BEFORE Slice 2 (feasibility → fewer sheets → strip density,
    // where density summed stripHeight × the result-level width).
    function priorIsBetter(a: NestingResult, b: NestingResult): boolean {
      if (a.unplaced.length !== b.unplaced.length) return a.unplaced.length < b.unplaced.length;
      if (a.sheets.length !== b.sheets.length) return a.sheets.length < b.sheets.length;
      const ua = a.sheets.reduce((s, x) => s + x.stripHeight * a.sheetWidth, 0);
      const ub = b.sheets.reduce((s, x) => s + x.stripHeight * b.sheetWidth, 0);
      return ua < ub;
    }

    const W = 100;
    const H = 100;
    const hom = (unplaced: number, strips: number[]) =>
      makeResult({ unplaced, sheets: strips.map((stripHeight) => ({ stripHeight, w: W, h: H })) });

    // A spread of homogeneous results varying unplaced, sheet count, and strip height.
    const samples = [
      hom(0, [50]),
      hom(0, [30]),
      hom(0, [50, 50]),
      hom(0, [10, 10]),
      hom(1, [10]),
      hom(2, [5]),
      hom(0, [99]),
    ];

    for (const a of samples) {
      for (const b of samples) {
        if (a === b) continue;
        expect(isBetterResult(a, b)).toBe(priorIsBetter(a, b));
      }
    }
  });
});

describe('availableSheets (sheet-list normalizer)', () => {
  it('normalizes a single configured sheet to a one-element list', () => {
    const cfg: NestingConfig = { ...fastConfig, sheet: { width: 600, height: 350 } };
    expect(availableSheets(cfg)).toEqual([{ width: 600, height: 350 }]);
  });

  it('returns the sheets list and lets it win over the single sheet', () => {
    const cfg: NestingConfig = {
      ...fastConfig,
      sheet: { width: 600, height: 350 },
      sheets: [{ width: 500, height: 400 }],
    };
    expect(availableSheets(cfg)).toEqual([{ width: 500, height: 400 }]);
  });

  it('throws when the sheets list is present but empty', () => {
    const cfg: NestingConfig = { ...fastConfig, sheets: [] };
    expect(() => availableSheets(cfg)).toThrow(/no sheet sizes/i);
  });

  it('round-trips maxCount: omitted stays undefined, provided is returned untouched', () => {
    const omitted: NestingConfig = { ...fastConfig, sheets: [{ width: 500, height: 400 }] };
    expect(availableSheets(omitted)[0].maxCount).toBeUndefined();

    const provided: NestingConfig = {
      ...fastConfig,
      sheets: [{ width: 500, height: 400, maxCount: 3 }],
    };
    expect(availableSheets(provided)[0].maxCount).toBe(3);
  });
});

describe('sheet-list config at the engine boundary', () => {
  it('rejects an empty sheet-size list from nestParts and opens no sheets', () => {
    const input = {
      parts: [makePart('a', 20, 20)],
      quantities: new Map([['a', 1]]),
      config: { ...fastConfig, sheets: [] },
    };
    expect(() => nestParts(input)).toThrow(/no sheet sizes/i);
  });

  it('rejects an empty sheet-size list from the iterative generator', () => {
    const gen = nestPartsIterative({
      parts: [makePart('a', 20, 20)],
      quantities: new Map([['a', 1]]),
      config: { ...fastConfig, sheets: [] },
    });
    expect(() => gen.next()).toThrow(/no sheet sizes/i);
  });

  it('nests from the sheets list (not the single sheet), picking the least-committed size', () => {
    // sheet (600×350) is present but the sheets list wins. Both listed sizes hold the parts, so
    // the engine opens the least-committed-area size (500×400 = 200000 < 700×300 = 210000) —
    // per-sheet dims and the top-level default both reflect the chosen size (Slice 3).
    const input = {
      parts: [makePart('a', 20, 20), makePart('b', 20, 20)],
      quantities: new Map([
        ['a', 1],
        ['b', 1],
      ]),
      config: {
        ...fastConfig,
        sheet: { width: 600, height: 350 },
        sheets: [
          { width: 700, height: 300 },
          { width: 500, height: 400 },
        ],
      },
    };
    const res = nestParts(input);
    expect(res.unplaced).toHaveLength(0);
    expect(res.sheets.length).toBeGreaterThan(0);
    expect(res.sheets[0].sheetWidth).toBe(500);
    expect(res.sheets[0].sheetHeight).toBe(400);
    expect(res.sheetWidth).toBe(500);
  });

  it('rejects an empty sheet-size list from nestPartsMultiStart', () => {
    const input = {
      parts: [makePart('a', 20, 20)],
      quantities: new Map([['a', 1]]),
      config: { ...fastConfig, sheets: [] },
    };
    expect(() => nestPartsMultiStart(input)).toThrow(/no sheet sizes/i);
  });
});

describe('per-sheet result dimensions', () => {
  const config: NestingConfig = { ...fastConfig, sheet: { width: 600, height: 350 } };

  it('still nests a single configured size onto one sheet with nothing unplaced', () => {
    const input = {
      parts: [makePart('a', 20, 20), makePart('b', 20, 20)],
      quantities: new Map([
        ['a', 1],
        ['b', 1],
      ]),
      config,
    };
    const res = nestParts(input);
    expect(res.sheets).toHaveLength(1);
    expect(res.unplaced).toHaveLength(0);
  });

  it('records the size used on each SheetResult', () => {
    const input = {
      parts: [makePart('a', 20, 20)],
      quantities: new Map([['a', 1]]),
      config,
    };
    const res = nestParts(input);
    expect(res.sheets[0].sheetWidth).toBe(600);
    expect(res.sheets[0].sheetHeight).toBe(350);
  });

  it('defaults the top-level result dimensions to the first sheet size', () => {
    const input = {
      parts: [makePart('a', 20, 20)],
      quantities: new Map([['a', 1]]),
      config,
    };
    const res = nestParts(input);
    expect(res.sheetWidth).toBe(600);
    expect(res.sheetHeight).toBe(350);
  });
});

const committedAreaOf = (res: NestingResult): number =>
  res.sheets.reduce((sum, s) => sum + s.sheetWidth * s.sheetHeight, 0);

const sizeKeys = (res: NestingResult): Set<string> =>
  new Set(res.sheets.map((s) => `${s.sheetWidth}x${s.sheetHeight}`));

const sizeCounts = (res: NestingResult): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const s of res.sheets) {
    const key = `${s.sheetWidth}x${s.sheetHeight}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

describe('selectSheetForNextOpen (Slice 3.1)', () => {
  const small = { width: 50, height: 50 };
  const large = { width: 100, height: 100 };

  it('picks the size that places more parts (stubbed evaluate)', () => {
    const evals = new Map([
      [small, { committedArea: 2500, placedCount: 1 }],
      [large, { committedArea: 10000, placedCount: 3 }],
    ]);
    const chosen = selectSheetForNextOpen([], [small, large], (s) => evals.get(s)!);
    expect(chosen).toBe(large);
  });

  it('breaks an equal-placed tie toward the least committed area (stubbed evaluate)', () => {
    const evals = new Map([
      [small, { committedArea: 2500, placedCount: 2 }],
      [large, { committedArea: 10000, placedCount: 2 }],
    ]);
    const chosen = selectSheetForNextOpen([], [small, large], (s) => evals.get(s)!);
    expect(chosen).toBe(small);
  });

  it('returns null when no size can hold the largest remaining part', () => {
    const part = makePart('big', 80, 80);
    const chosen = selectSheetForNextOpen([part], [small], () => ({
      committedArea: 2500,
      placedCount: 1,
    }));
    expect(chosen).toBeNull();
  });

  it('discards sizes too small for the largest part before scoring survivors', () => {
    const part = makePart('mid', 70, 70); // fits large (100) but not small (50)
    const chosen = selectSheetForNextOpen([part], [small, large], () => ({
      committedArea: 1,
      placedCount: 99,
    }));
    expect(chosen).toBe(large);
  });
});

describe('engine mixes sheet sizes per opened sheet (Slice 3.1)', () => {
  it('uses both sizes when each part fits only one of them, placing everything', () => {
    // small 100×100 holds the 90×90 squares but not the 180×40 bars; large 200×50 holds the
    // bars but not the squares — placing every part requires sheets of BOTH sizes.
    const config: NestingConfig = {
      ...fastConfig,
      sheets: [
        { width: 100, height: 100 },
        { width: 200, height: 50 },
      ],
    };
    const parts = [
      makePart('sq1', 90, 90),
      makePart('sq2', 90, 90),
      makePart('bar1', 180, 40),
      makePart('bar2', 180, 40),
    ];
    const q = new Map(parts.map((p) => [p.id, 1]));
    const res = nestParts({ parts, quantities: q, config });

    expect(res.unplaced).toHaveLength(0);
    expect(sizeKeys(res).has('100x100')).toBe(true);
    expect(sizeKeys(res).has('200x50')).toBe(true);
  });

  it('mixes sizes for less committed area than either feasible single-size baseline', () => {
    // Seven full-width 100×33 strips (1-D stacking, GA-deterministic). small 100×100 holds 3,
    // large 100×175 holds 5. Greedy mixing fills one large (5) then one small (2) = 27500, which
    // beats large-only (two large = 35000) and small-only (three small = 30000).
    const small = { width: 100, height: 100 };
    const large = { width: 100, height: 175 };
    const parts = Array.from({ length: 7 }, (_, i) => makePart(`p${i}`, 100, 33));
    const q = new Map(parts.map((p) => [p.id, 1]));

    const mixed = nestParts({
      parts,
      quantities: q,
      config: { ...fastConfig, sheets: [small, large] },
    });
    const largeOnly = nestParts({
      parts,
      quantities: q,
      config: { ...fastConfig, sheets: [large] },
    });
    const smallOnly = nestParts({
      parts,
      quantities: q,
      config: { ...fastConfig, sheets: [small] },
    });

    expect(mixed.unplaced).toHaveLength(0);
    expect(largeOnly.unplaced).toHaveLength(0);
    expect(smallOnly.unplaced).toHaveLength(0);
    expect(sizeKeys(mixed).has('100x175')).toBe(true);
    expect(sizeKeys(mixed).has('100x100')).toBe(true);
    expect(committedAreaOf(mixed)).toBeLessThan(committedAreaOf(largeOnly));
    expect(committedAreaOf(mixed)).toBeLessThan(committedAreaOf(smallOnly));
  });

  it('uses only the large size when all parts fit one large sheet with room to spare', () => {
    const config: NestingConfig = {
      ...fastConfig,
      sheets: [
        { width: 50, height: 50 },
        { width: 200, height: 200 },
      ],
    };
    // Five 30×30 squares: a 50×50 holds only one (2×30 > 50); a 200×200 holds all five.
    const parts = Array.from({ length: 5 }, (_, i) => makePart(`s${i}`, 30, 30));
    const q = new Map(parts.map((p) => [p.id, 1]));
    const res = nestParts({ parts, quantities: q, config });

    expect(res.unplaced).toHaveLength(0);
    expect(res.sheets.every((s) => s.sheetWidth === 200 && s.sheetHeight === 200)).toBe(true);
  });

  it('leaves a part that fits no available size unplaced and opens no sheet', () => {
    const config: NestingConfig = {
      ...fastConfig,
      sheets: [
        { width: 50, height: 50 },
        { width: 60, height: 60 },
      ],
    };
    const parts = [makePart('huge', 100, 100)];
    const q = new Map([['huge', 1]]);
    const res = nestParts({ parts, quantities: q, config });

    expect(res.sheets).toHaveLength(0);
    expect(res.unplaced).toHaveLength(1);
  });

  it('places the parts that fit and overflows only the permanently-unfittable one', () => {
    // 'huge' fits no available size; the three 30×30 squares each fit either size. The oversized
    // part must not strand the fittable ones — they get placed, only 'huge' lands in unplaced.
    const config: NestingConfig = {
      ...fastConfig,
      sheets: [
        { width: 50, height: 50 },
        { width: 60, height: 60 },
      ],
    };
    const parts = [
      makePart('huge', 100, 100),
      makePart('f0', 30, 30),
      makePart('f1', 30, 30),
      makePart('f2', 30, 30),
    ];
    const q = new Map(parts.map((p) => [p.id, 1]));
    const res = nestParts({ parts, quantities: q, config });

    expect(res.sheets.length).toBeGreaterThanOrEqual(1);
    expect(res.totalPlaced).toBe(3);
    expect(res.unplaced).toHaveLength(1);
    expect(res.unplaced[0].id).toContain('huge');
  });
});

describe('lower bound + multi-start sweep over the size set (Slice 3.2)', () => {
  it('sheetLowerBound uses the given (largest) size area: 1.5x ⇒ 2', () => {
    // large 100×100 = 10000; one 100×150 part = 15000 true area (1.5x) ⇒ ceil(1.5) = 2.
    const parts = [makePart('a', 100, 150)];
    const q = new Map([['a', 1]]);
    expect(sheetLowerBound(parts, q, { width: 100, height: 100 })).toBe(2);
  });

  it('sheetLowerBound is 1 for 0.5x the large size even though it exceeds a small size', () => {
    // large 200×200 = 40000; one 200×100 part = 20000 (0.5x large) ⇒ bound 1, although it
    // exceeds a 100×100 small size (10000) which alone would force 2.
    const parts = [makePart('a', 200, 100)];
    const q = new Map([['a', 1]]);
    expect(sheetLowerBound(parts, q, { width: 200, height: 200 })).toBe(1);
  });

  it('packIntoKSheets assigns each group an in-supply size that holds it', () => {
    // The primary (first) size 100×100 cannot hold the 180×40 bars; the second size 200×50 can.
    // Per-group size selection must pick the fitting size, not only the primary.
    const config: NestingConfig = {
      ...fastConfig,
      sheets: [
        { width: 100, height: 100 },
        { width: 200, height: 50 },
      ],
    };
    const parts = [makePart('bar0', 180, 40), makePart('bar1', 180, 40)];
    const originals = new Map(parts.map((p) => [p.id, p]));
    const res = packIntoKSheets(parts, originals, config, 2);

    expect(res.unplaced).toHaveLength(0);
    expect(res.sheets.every((s) => s.sheetWidth === 200 && s.sheetHeight === 50)).toBe(true);
  });

  it('packIntoKSheets picks the least-committed size per group when several fit', () => {
    // Both sizes hold a single 40×40 square; each group should commit the smaller area.
    const config: NestingConfig = {
      ...fastConfig,
      sheets: [
        { width: 200, height: 200 },
        { width: 50, height: 50 },
      ],
    };
    const parts = [makePart('a', 40, 40), makePart('b', 40, 40)];
    const originals = new Map(parts.map((p) => [p.id, p]));
    const res = packIntoKSheets(parts, originals, config, 2);

    expect(res.unplaced).toHaveLength(0);
    expect(res.sheets.every((s) => s.sheetWidth === 50 && s.sheetHeight === 50)).toBe(true);
  });

  it('multi-start does not regress the mixed-size greedy result', () => {
    // Same strip fixture as Slice 3.1: greedy mixing yields one large + one small = 27500.
    // Multi-start must keep a result no worse than that (all placed, both sizes, ≤ baselines).
    const small = { width: 100, height: 100 };
    const large = { width: 100, height: 175 };
    const parts = Array.from({ length: 7 }, (_, i) => makePart(`p${i}`, 100, 33));
    const q = new Map(parts.map((p) => [p.id, 1]));
    const config: NestingConfig = { ...fastConfig, sheets: [small, large] };

    const greedy = nestParts({ parts, quantities: q, config });
    const multi = nestPartsMultiStart({ parts, quantities: q, config }, { maxStarts: 3 });

    expect(multi.unplaced).toHaveLength(0);
    expect(isBetterResult(greedy, multi)).toBe(false);
    expect(committedAreaOf(multi)).toBeLessThanOrEqual(committedAreaOf(greedy));
  });
});

describe('per-size supply caps + exhaustion (Slice 4)', () => {
  // Full-width 100x60 strips: two never stack on a 100x100 sheet (60+60 > 100) and never sit
  // side by side (100+100 > 100), so each sheet holds exactly one — geometry-forced, GA-proof.
  const strip = (id: string) => makePart(id, 100, 60);

  it('never opens more sheets of a size than its maxCount (one capped size)', () => {
    const config: NestingConfig = {
      ...fastConfig,
      sheets: [{ width: 100, height: 100, maxCount: 2 }],
    };
    const parts = [strip('a'), strip('b'), strip('c')];
    const q = new Map(parts.map((p) => [p.id, 1]));
    const res = nestParts({ parts, quantities: q, config });

    expect(res.sheets).toHaveLength(2);
    expect(sizeCounts(res).get('100x100')).toBe(2);
    expect(res.totalPlaced).toBe(2);
    expect(res.unplaced).toHaveLength(1);
  });

  it('strands a REQUIRED part in unplaced when capped supply cannot hold it', () => {
    // A (100x100, cap 1) fits only the 95x95 squares; B (200x80, cap 1) fits only the 190x70 bar.
    // All three parts are REQUIRED and each needs its own sheet, but supply totals 2 ⇒ exactly 1
    // of each opened, the third (sqZ) genuinely cannot be placed and lands in unplaced.
    const A = { width: 100, height: 100, maxCount: 1 };
    const B = { width: 200, height: 80, maxCount: 1 };
    const config: NestingConfig = { ...fastConfig, sheets: [A, B] };
    const parts = [
      makePart('sqX', 95, 95, { priority: 'required' }),
      makePart('barY', 190, 70, { priority: 'required' }),
      makePart('sqZ', 95, 95, { priority: 'required' }),
    ];
    const q = new Map(parts.map((p) => [p.id, 1]));

    const res = nestParts({ parts, quantities: q, config });

    // Deterministic termination bound: never open more sheets than total available supply (2).
    expect(res.sheets.length).toBeLessThanOrEqual(2);
    expect(res.sheets).toHaveLength(2);
    expect(sizeCounts(res).get('100x100')).toBe(1);
    expect(sizeCounts(res).get('200x80')).toBe(1);
    expect(res.totalPlaced).toBe(2);
    // The stranded part is the REQUIRED sqZ — pin its identity and priority.
    expect(res.unplaced).toHaveLength(1);
    expect(res.unplaced[0].id).toContain('sqZ');
    expect(res.unplaced[0].priority).toBe('required');
    // No cap exceeded for any size.
    for (const [, count] of sizeCounts(res)) expect(count).toBeLessThanOrEqual(1);
  });

  it('drops an OPTIONAL part under exhaustion without claiming a scarce sheet from required parts', () => {
    // One 100x100 size, cap 2. Three REQUIRED squares each need their own sheet (3 > supply 2),
    // plus one OPTIONAL part. Required parts must win the two scarce sheets; the optional part is
    // dropped rather than consuming a sheet a required part needs.
    const config: NestingConfig = {
      ...fastConfig,
      sheets: [{ width: 100, height: 100, maxCount: 2 }],
    };
    const parts = [
      makePart('R1', 95, 95, { priority: 'required' }),
      makePart('R2', 95, 95, { priority: 'required' }),
      makePart('R3', 95, 95, { priority: 'required' }),
      makePart('O', 60, 60, { priority: 'optional' }),
    ];
    const q = new Map(parts.map((p) => [p.id, 1]));

    const res = nestParts({ parts, quantities: q, config });

    // Deterministic termination bound: at most the available supply (2 sheets).
    expect(res.sheets.length).toBeLessThanOrEqual(2);
    expect(res.sheets).toHaveLength(2);
    expect(res.totalPlaced).toBe(2);
    // Every placed part is a required one — the optional part never claimed a scarce sheet.
    const placed = res.sheets.flatMap((s) => s.placed.map((pp) => pp.part));
    expect(placed.every((p) => (p.priority ?? 'required') === 'required')).toBe(true);
    // The optional part is dropped, and a required part (R3) is also stranded by the shortfall.
    const unplacedIds = res.unplaced.map((p) => p.id);
    expect(unplacedIds).toContain('O_0');
    expect(unplacedIds.some((id) => id.startsWith('R'))).toBe(true);
  });

  it('a maxCount of 0 never opens a sheet; parts that fit only it go to unplaced', () => {
    // A (100x100) is born exhausted (cap 0); B (40x40) is available. 'big' fits only A and so can
    // never be placed; 'small' fits B and is placed normally.
    const A = { width: 100, height: 100, maxCount: 0 };
    const B = { width: 40, height: 40 };
    const config: NestingConfig = { ...fastConfig, sheets: [A, B] };
    const parts = [makePart('big', 50, 50), makePart('small', 30, 30)];
    const q = new Map(parts.map((p) => [p.id, 1]));

    const res = nestParts({ parts, quantities: q, config });

    // No 100x100 sheet is ever opened (cap 0).
    expect(sizeCounts(res).get('100x100') ?? 0).toBe(0);
    expect(res.sheets).toHaveLength(1);
    expect(sizeCounts(res).get('40x40')).toBe(1);
    expect(res.totalPlaced).toBe(1);
    expect(res.unplaced).toHaveLength(1);
    expect(res.unplaced[0].id).toContain('big');
  });

  it('multi-start respects caps and bounds on supply exhaustion (required parts remain)', () => {
    const A = { width: 100, height: 100, maxCount: 1 };
    const B = { width: 200, height: 80, maxCount: 1 };
    const config: NestingConfig = { ...fastConfig, sheets: [A, B] };
    const parts = [
      makePart('sqX', 95, 95, { priority: 'required' }),
      makePart('barY', 190, 70, { priority: 'required' }),
      makePart('sqZ', 95, 95, { priority: 'required' }),
    ];
    const q = new Map(parts.map((p) => [p.id, 1]));

    const res = nestPartsMultiStart({ parts, quantities: q, config }, { maxStarts: 3 });

    // Deterministic termination bound: never more sheets than the total available supply (2).
    expect(res.sheets.length).toBeLessThanOrEqual(2);
    expect(sizeCounts(res).get('100x100') ?? 0).toBeLessThanOrEqual(1);
    expect(sizeCounts(res).get('200x80') ?? 0).toBeLessThanOrEqual(1);
    expect(res.unplaced).toHaveLength(1);
    // The stranded part is the REQUIRED sqZ — pin its identity.
    expect(res.unplaced[0].id).toContain('sqZ');
    expect(res.unplaced[0].priority).toBe('required');
  });

  it('packIntoKSheets never assigns a size beyond its cap', () => {
    const A = { width: 100, height: 100, maxCount: 1 };
    const config: NestingConfig = { ...fastConfig, sheets: [A] };
    const parts = [makePart('sq0', 95, 95), makePart('sq1', 95, 95)];
    const originals = new Map(parts.map((p) => [p.id, p]));
    const res = packIntoKSheets(parts, originals, config, 2);

    // Deterministic termination bound: never more sheets than the total available supply (1).
    expect(res.sheets.length).toBeLessThanOrEqual(1);
    expect(res.sheets).toHaveLength(1);
    expect(sizeCounts(res).get('100x100')).toBe(1);
    expect(res.unplaced).toHaveLength(1);
    // The second group's part (sq1) is the one left unplaced — pin its identity.
    expect(res.unplaced[0].id).toContain('sq1');
  });

  it('omitted maxCount means unlimited supply: opens as many sheets as needed', () => {
    const config: NestingConfig = {
      ...fastConfig,
      sheets: [{ width: 100, height: 100 }],
    };
    const parts = Array.from({ length: 8 }, (_, i) => strip(`p${i}`));
    const q = new Map(parts.map((p) => [p.id, 1]));
    const res = nestParts({ parts, quantities: q, config });

    expect(res.sheets).toHaveLength(8);
    expect(sizeCounts(res).get('100x100')).toBe(8);
    expect(res.unplaced).toHaveLength(0);
    expect(res.totalPlaced).toBe(8);
  });
});
