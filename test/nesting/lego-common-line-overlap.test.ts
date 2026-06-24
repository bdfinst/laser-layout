import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseLightBurn } from '$lib/parsers/lightburn-parser';
import { groupByContainment, removeCoincidentDuplicates } from '$lib/geometry/grouping';
import { deduplicateParts } from '$lib/geometry/dedup';
import { nestParts } from '$lib/nesting/engine';
import { getPlacedPolygons } from '$lib/geometry/polygon';
import { pointInPolygon } from '$lib/nesting/nfp';
import { seedRandom, restoreRandom } from '../support/seeded-random';
import type { NestingConfig, Part, Point, Polygon } from '$lib/geometry/types';

// Real-overlap detector for simple (possibly concave) part outlines. Two parts genuinely
// interpenetrate iff a vertex of one lies inside the other deeper than PEN_EPS. The depth
// gate is what distinguishes a true overlap from common-line ABUTMENT: parts placed
// edge-to-edge at kerf 0 touch (penetration ~0) and must NOT count as overlapping. SAT
// (`polygonsOverlap`) is convex-only and unusable on these concave brackets.
const PEN_EPS = 1e-3; // 1 micron — far below laser precision, far above float noise

function distToBoundary(p: Point, poly: Polygon): number {
  let min = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const ex = p.x - (a.x + t * dx);
    const ey = p.y - (a.y + t * dy);
    min = Math.min(min, Math.hypot(ex, ey));
  }
  return min;
}

// Deepest interpenetration between two outlines (mm); 0 when merely touching or disjoint.
function penetration(a: Polygon, b: Polygon): number {
  let max = 0;
  for (const p of a) if (pointInPolygon(p, b)) max = Math.max(max, distToBoundary(p, b));
  for (const p of b) if (pointInPolygon(p, a)) max = Math.max(max, distToBoundary(p, a));
  return max;
}

// Settings from the user's screenshot: 508 x 762 mm, kerf 1mm,
// Maximize density ON (useNfpPlacement), Common-line cutting ON.
const CONFIG: NestingConfig = {
  sheet: { width: 508, height: 762 },
  kerf: 1,
  rotationSteps: 72,
  populationSize: 30,
  generations: 40,
  useNfpPlacement: true,
  commonLineCutting: true,
  timeBudgetMs: 15000,
};

// The NFP nest can run to its full time budget; give the test room beyond vitest's 5s default.
const TEST_TIMEOUT_MS = 60000;

function pipeline(): Part[] {
  const xml = readFileSync(resolve('test-fixtures/lego-shelves.lbrn2'), 'utf-8');
  return groupByContainment(removeCoincidentDuplicates(parseLightBurn(xml)));
}

function nest(cfg: NestingConfig) {
  const grouped = pipeline();
  const { uniqueParts, quantities } = deduplicateParts(grouped);
  const result = nestParts({ parts: uniqueParts, quantities, config: cfg });
  let placed = 0;
  let worstPenetration = 0;
  for (const sheet of result.sheets) {
    placed += sheet.placed.length;
    const outers = sheet.placed.map((pp) => getPlacedPolygons(pp)[0]);
    for (let i = 0; i < outers.length; i++) {
      for (let j = i + 1; j < outers.length; j++) {
        worstPenetration = Math.max(worstPenetration, penetration(outers[i], outers[j]));
      }
    }
  }
  return { placed, worstPenetration };
}

// Regression for the common-line overlap bug. Two root causes were fixed:
//   1. the kerf-0 collision test used convex-only SAT, so concave parts could overlap;
//   2. the GA packs on RDP-simplified outlines, and at kerf 0 the simplification slack
//      surfaced as overlapping cuts — fixed by re-seating the committed placement on
//      full-fidelity geometry (finalizePlacement) in common-line mode.
describe('Common-line cutting produces no overlapping cuts (lego-shelves)', () => {
  // Seed 7 is the trajectory that reproduced the original 0.295mm interpenetration
  // (see nfp-fullfidelity-overlap.test.ts), so pin it — an unseeded run may never
  // exercise the regressing path and silently stop guarding the bug.
  beforeEach(() => seedRandom(7));
  afterEach(() => restoreRandom());

  it(
    'NFP + common-line (the reported scenario) abuts parts without interpenetration',
    () => {
      const { placed, worstPenetration } = nest({
        ...CONFIG,
        useNfpPlacement: true,
        commonLineCutting: true,
      });
      expect(placed).toBe(12);
      expect(worstPenetration).toBeLessThan(PEN_EPS);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'common-line without NFP also abuts parts without interpenetration',
    () => {
      const { placed, worstPenetration } = nest({
        ...CONFIG,
        useNfpPlacement: false,
        commonLineCutting: true,
      });
      expect(placed).toBe(12);
      expect(worstPenetration).toBeLessThan(PEN_EPS);
    },
    TEST_TIMEOUT_MS,
  );
});
