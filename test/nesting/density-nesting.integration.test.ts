import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseLightBurn } from '$lib/parsers/lightburn-parser';
import { groupByContainment, removeCoincidentDuplicates } from '$lib/geometry/grouping';
import { deduplicateParts } from '$lib/geometry/dedup';
import { nestParts } from '$lib/nesting/engine';
import type { Part, NestingConfig } from '$lib/geometry/types';

// Deterministic GA: seed Math.random with the same LCG the other nesting tests use,
// so the recorded baselines below are reproducible.
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

function rect(id: string, w: number, h: number): Part {
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

describe('density-aware nesting — effectiveness and non-regression (capstone)', () => {
  // A4: gap-filling effectiveness. A column-gap layout of SOLID rectangles (so the
  // utilization metric is identical pre/post the true-area change). Measured under seed 42:
  // pre-change (strip-height fitness, no gap-fill) first-sheet utilization = 0.828;
  // post-change (gap-filling) = 0.913 — a +0.085 absolute gain on the packed sheet.
  it('A4: gap-filling packs the primary sheet >= 0.05 denser on a gap-prone layout', () => {
    const config: NestingConfig = {
      sheet: { width: 100, height: 120 },
      kerf: 0,
      rotationSteps: 8,
      populationSize: 20,
      generations: 40,
    };
    const parts = [
      rect('t1', 40, 90),
      rect('t2', 35, 70),
      ...Array.from({ length: 10 }, (_, i) => rect(`m${i}`, 22, 22)),
    ];
    const quantities = new Map(parts.map((p) => [p.id, 1]));
    const result = nestParts({ parts, quantities, config });

    const PRE_CHANGE_FIRST_SHEET_UTIL = 0.828; // recorded on main, same metric (solid rects)
    expect(result.sheets[0].utilization).toBeGreaterThanOrEqual(PRE_CHANGE_FIRST_SHEET_UTIL + 0.05);
  });

  // A5 / A11: non-regression on the real LightBurn fixture at the default-ish stock size.
  // Baselines recorded on this branch under the new true-area metric (seed 42).
  it('A5/A11: lego fixture packs all parts on one 760mm sheet without regressing', () => {
    const xml = readFileSync(resolve('test-fixtures/lego-shelves.lbrn2'), 'utf-8');
    const grouped = groupByContainment(removeCoincidentDuplicates(parseLightBurn(xml)));
    const { uniqueParts, quantities } = deduplicateParts(grouped);
    const config: NestingConfig = {
      sheet: { width: 760, height: 760 },
      kerf: 1,
      rotationSteps: 72,
      populationSize: 30,
      generations: 40,
    };

    const result = nestParts({ parts: uniqueParts, quantities, config });

    // No part dropped; fits on a single sheet (overflow behaviour preserved).
    expect(result.unplaced).toHaveLength(0);
    expect(result.totalPlaced).toBe(12);
    expect(result.sheets).toHaveLength(1);

    // Strip height is metric-independent. Baseline 614mm (main: 617mm) — guard against
    // future packing regressions with a small margin.
    expect(result.sheets[0].stripHeight).toBeLessThanOrEqual(630);
    // True-area utilization baseline ~0.62 (the panels are ~25% cutouts, honestly excluded).
    expect(result.sheets[0].utilization).toBeGreaterThanOrEqual(0.6);
  });

  // Runtime budget: convergence + the bounded coarse-step slide must keep a realistic
  // job fast. Generous bound so it is not flaky in CI, but catches gross blow-ups.
  it('runtime budget: a realistic nest completes well under the safety cap', () => {
    const xml = readFileSync(resolve('test-fixtures/lego-shelves.lbrn2'), 'utf-8');
    const grouped = groupByContainment(removeCoincidentDuplicates(parseLightBurn(xml)));
    const { uniqueParts, quantities } = deduplicateParts(grouped);
    const config: NestingConfig = {
      sheet: { width: 760, height: 760 },
      kerf: 1,
      rotationSteps: 72,
      populationSize: 30,
      generations: 40,
    };

    const start = performance.now();
    nestParts({ parts: uniqueParts, quantities, config });
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(15000);
  });
});
