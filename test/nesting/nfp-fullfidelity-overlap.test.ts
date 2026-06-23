import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseLightBurn } from '$lib/parsers/lightburn-parser';
import { groupByContainment, removeCoincidentDuplicates } from '$lib/geometry/grouping';
import { deduplicateParts } from '$lib/geometry/dedup';
import { nestParts } from '$lib/nesting/engine';
import { getPlacedPolygons } from '$lib/geometry/polygon';
import { polygonsInterpenetrate } from '$lib/nesting/nfp';
import type { NestingConfig } from '$lib/geometry/types';

// Regression for the full-fidelity overlap bug (#26 follow-up). The GA packs on RDP-simplified
// outlines (tolerance ~1% of bbox, which on large lego parts exceeds the kerf), and the tight NFP
// feasible seats (#26) place parts exactly kerf apart on the simplified shapes — so the restored
// full-fidelity outlines could interpenetrate. Non-common-line mode previously only swapped
// geometry (no re-seat), surfacing the overlap. The engine now re-seats on full fidelity whenever
// the swap interpenetrates, so the rendered/exported result must be overlap-free at any seed.

const orig = Math.random;
afterEach(() => {
  Math.random = orig;
});

function seedRandom(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  Math.random = () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function hasInterpenetration(result: ReturnType<typeof nestParts>): boolean {
  for (const sheet of result.sheets) {
    const polys = sheet.placed.map((pp) => getPlacedPolygons(pp)[0]);
    for (let i = 0; i < polys.length; i++) {
      for (let j = i + 1; j < polys.length; j++) {
        if (polygonsInterpenetrate(polys[i], polys[j])) return true;
      }
    }
  }
  return false;
}

describe('NFP density placement is overlap-free on full-fidelity geometry', () => {
  const xml = readFileSync(resolve('test-fixtures/lego-shelves.lbrn2'), 'utf-8');
  const { uniqueParts: parts, quantities } = deduplicateParts(
    groupByContainment(removeCoincidentDuplicates(parseLightBurn(xml))),
  );
  const base: NestingConfig = {
    sheet: { width: 508, height: 762 },
    kerf: 1,
    rotationSteps: 72,
    populationSize: 30,
    generations: 40,
    useNfpPlacement: true,
    commonLineCutting: false,
    timeBudgetMs: 12000,
  };

  // seed 7 produced a 0.295 mm interpenetration before the full-fidelity re-seat fix.
  for (const seed of [7, 999]) {
    it(`places lego with no interpenetration (seed ${seed})`, () => {
      seedRandom(seed);
      const result = nestParts({ parts, quantities, config: base });
      expect(result.totalPlaced).toBe(12);
      expect(hasInterpenetration(result)).toBe(false);
    }, 60_000);
  }
});
