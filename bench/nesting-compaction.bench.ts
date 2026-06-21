import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseLightBurn } from '$lib/parsers/lightburn-parser';
import { groupByContainment, removeCoincidentDuplicates } from '$lib/geometry/grouping';
import { deduplicateParts } from '$lib/geometry/dedup';
import { nestParts, nestPartsMultiStart, type NestingResult } from '$lib/nesting/engine';
import { getPlacedPolygons, boundingBox, polygonArea } from '$lib/geometry/polygon';
import type { NestingConfig, Part } from '$lib/geometry/types';

/**
 * Nesting compaction benchmark — NOT part of `npm test`. Run with `npm run bench`.
 *
 * Reports branch-independent KPIs averaged over several RNG seeds, so it is a fair
 * before/after tuning tool (e.g. when changing fitness, placement, or the GA cap).
 * Compare two branches by checking out each and re-running.
 *
 *   usedArea = sum over sheets of (stripHeight * sheetWidth)   — lower is tighter
 *   trueFill = total true part area / usedArea                  — higher is denser
 *   ms       = wall-clock per full nest (mean over seeds)
 */

function seedRandom(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  Math.random = () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function kpis(result: NestingResult, sheetW: number) {
  let totalTrue = 0;
  let usedArea = 0;
  for (const sheet of result.sheets) {
    let stripH = 0;
    let trueA = 0;
    for (const pp of sheet.placed) {
      const polys = getPlacedPolygons(pp);
      let t = polygonArea(polys[0]);
      for (let i = 1; i < polys.length; i++) t -= polygonArea(polys[i]);
      trueA += t;
      for (const poly of polys) {
        const b = boundingBox(poly);
        if (b.maxY > stripH) stripH = b.maxY;
      }
    }
    usedArea += stripH * sheetW;
    totalTrue += trueA;
  }
  return {
    sheets: result.sheets.length,
    placed: result.totalPlaced,
    unplaced: result.unplaced.length,
    usedArea,
    trueFill: usedArea > 0 ? totalTrue / usedArea : 0,
  };
}

function loadFixture(file: string): { parts: Part[]; quantities: Map<string, number> } {
  const xml = readFileSync(resolve(`test-fixtures/${file}`), 'utf-8');
  const grouped = groupByContainment(removeCoincidentDuplicates(parseLightBurn(xml)));
  const { uniqueParts, quantities } = deduplicateParts(grouped);
  return { parts: uniqueParts, quantities };
}

const SEEDS = [42, 7, 123, 999, 2024];
const SHEETS = [400, 600, 760];
const FIXTURES = ['lego-shelves.lbrn2', 'Hot Air Balloon.lbrn2'];

describe('nesting compaction benchmark', () => {
  it('reports KPIs per fixture and sheet size (mean over seeds)', () => {
    const orig = Math.random;
    const rows: string[] = [];
    rows.push(
      ['fixture', 'sheet', 'sheets', 'placed', 'unpl', 'usedArea', 'trueFill', 'ms'].join('\t'),
    );

    for (const file of FIXTURES) {
      const { parts, quantities } = loadFixture(file);
      for (const dim of SHEETS) {
        const config: NestingConfig = {
          sheet: { width: dim, height: dim },
          kerf: 1,
          rotationSteps: 72,
          populationSize: 30,
          generations: 40,
        };
        const agg = { sheets: 0, placed: 0, unplaced: 0, usedArea: 0, trueFill: 0, ms: 0 };
        for (const seed of SEEDS) {
          seedRandom(seed);
          const t0 = performance.now();
          const res = nestParts({ parts, quantities, config });
          agg.ms += performance.now() - t0;
          const r = kpis(res, dim);
          agg.sheets += r.sheets;
          agg.placed += r.placed;
          agg.unplaced += r.unplaced;
          agg.usedArea += r.usedArea;
          agg.trueFill += r.trueFill;
          // sanity: a fixture that fits should place at least one part
          expect(r.placed).toBeGreaterThan(0);
        }
        const n = SEEDS.length;
        rows.push(
          [
            file.replace('.lbrn2', ''),
            `${dim}`,
            (agg.sheets / n).toFixed(2),
            (agg.placed / n).toFixed(1),
            (agg.unplaced / n).toFixed(1),
            `${Math.round(agg.usedArea / n)}`,
            (agg.trueFill / n).toFixed(4),
            `${Math.round(agg.ms / n)}`,
          ].join('\t'),
        );
      }
    }

    // Epic #24 KPI: lego-shelves on the 20x30 in (508x762 mm) default stock sheet, which a
    // human nests onto a single sheet. Reported separately because it is non-square and
    // lego-specific. Flip `useNfpPlacement` to measure the NFP placement path (P3–P5).
    {
      const { parts, quantities } = loadFixture('lego-shelves.lbrn2');
      const [w, h] = [508, 762];
      for (const useNfpPlacement of [false, true]) {
        const config: NestingConfig = {
          sheet: { width: w, height: h },
          kerf: 1,
          rotationSteps: 72,
          populationSize: 30,
          generations: 40,
          useNfpPlacement,
        };
        const agg = { sheets: 0, placed: 0, unplaced: 0, usedArea: 0, trueFill: 0, ms: 0 };
        for (const seed of SEEDS) {
          seedRandom(seed);
          const t0 = performance.now();
          const res = nestParts({ parts, quantities, config });
          agg.ms += performance.now() - t0;
          const r = kpis(res, w);
          agg.sheets += r.sheets;
          agg.placed += r.placed;
          agg.unplaced += r.unplaced;
          agg.usedArea += r.usedArea;
          agg.trueFill += r.trueFill;
        }
        const n = SEEDS.length;
        rows.push(
          [
            `lego-shelves[nfp=${useNfpPlacement ? 1 : 0}]`,
            `${w}x${h}`,
            (agg.sheets / n).toFixed(2),
            (agg.placed / n).toFixed(1),
            (agg.unplaced / n).toFixed(1),
            `${Math.round(agg.usedArea / n)}`,
            (agg.trueFill / n).toFixed(4),
            `${Math.round(agg.ms / n)}`,
          ].join('\t'),
        );
      }
    }

    // Multi-start KPI: the real product strategy (repeat the nest, keep the best, stop at the
    // area lower bound) on the default stock sheet. This is the row that should reach 1 sheet.
    {
      const { parts, quantities } = loadFixture('lego-shelves.lbrn2');
      const [w, h] = [508, 762];
      const config: NestingConfig = {
        sheet: { width: w, height: h },
        kerf: 1,
        rotationSteps: 72,
        populationSize: 30,
        generations: 40,
        useNfpPlacement: true,
      };
      const agg = { sheets: 0, placed: 0, unplaced: 0, usedArea: 0, trueFill: 0, ms: 0 };
      for (const seed of SEEDS) {
        seedRandom(seed);
        const t0 = performance.now();
        // Bounded so `npm run bench` stays under its timeout; the app's budget is larger and
        // user-adjustable, so production reaches one sheet more often than this row shows.
        const res = nestPartsMultiStart({ parts, quantities, config }, { timeBudgetMs: 40_000 });
        agg.ms += performance.now() - t0;
        const r = kpis(res, w);
        agg.sheets += r.sheets;
        agg.placed += r.placed;
        agg.unplaced += r.unplaced;
        agg.usedArea += r.usedArea;
        agg.trueFill += r.trueFill;
      }
      const n = SEEDS.length;
      rows.push(
        [
          'lego-shelves[multistart]',
          `${w}x${h}`,
          (agg.sheets / n).toFixed(2),
          (agg.placed / n).toFixed(1),
          (agg.unplaced / n).toFixed(1),
          `${Math.round(agg.usedArea / n)}`,
          (agg.trueFill / n).toFixed(4),
          `${Math.round(agg.ms / n)}`,
        ].join('\t'),
      );
    }

    Math.random = orig;
    console.log('\n' + rows.join('\n') + '\n');
  });
});
