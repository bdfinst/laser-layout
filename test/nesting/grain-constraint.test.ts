import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  optimize,
  toOrderedParts,
  snapToGrain,
  DEFAULT_OPTIMIZER_CONFIG,
  type Individual,
} from '$lib/nesting/optimizer';
import { nestParts } from '$lib/nesting/engine';
import { makeRect } from '../support/parts';
import { seedRandom, restoreRandom } from '../support/seeded-random';
import type { Part } from '$lib/geometry/types';

const makePart = (id: string, w: number, h: number, grainConstraint = false) =>
  makeRect(id, w, h, { grainConstraint });

const PI = Math.PI;
const HALF_PI = Math.PI / 2;

const fastConfig = {
  ...DEFAULT_OPTIMIZER_CONFIG,
  populationSize: 12,
  maxGenerations: 6,
  stallWindow: 6,
  stallEpsilon: 0.005,
  rotationSteps: 8, // includes 90°/270°, so the snap has something to clamp away
};

// Seed by default so determinism is the default, not a per-test opt-in; the integration
// tests below re-seed with specific values for their own trajectories.
beforeEach(() => seedRandom());
afterEach(() => restoreRandom());

describe('snapToGrain', () => {
  it('keeps the grain-allowed angles fixed', () => {
    expect(snapToGrain(0)).toBe(0);
    expect(snapToGrain(PI)).toBe(PI);
  });

  it('folds cross-grain rotations onto the nearest of 0° / 180°', () => {
    expect(snapToGrain(HALF_PI + 0.1)).toBe(PI); // just past 90° → 180°
    expect(snapToGrain(HALF_PI - 0.1)).toBe(0); // just under 90° → 0°
    expect(snapToGrain(PI + HALF_PI)).toBe(0); // 270° → 0°
  });

  it('normalizes out-of-range and negative angles before snapping', () => {
    expect(snapToGrain(2 * PI)).toBe(0);
    expect(snapToGrain(-HALF_PI)).toBe(0); // -90° ≡ 270° → 0°
    expect(snapToGrain(2 * PI + PI)).toBe(PI);
  });
});

describe('toOrderedParts honors grainConstraint (consumption-time snap)', () => {
  it('snaps a grain-constrained part to 0°/180° while leaving free parts untouched', () => {
    const parts = [makePart('grain', 10, 10, true), makePart('free', 10, 10, false)];
    const individual: Individual = {
      rotations: [HALF_PI, HALF_PI], // both genes at 90°
      order: [0, 1],
      mirrors: [false, false],
      fitness: 0,
      placement: [],
    };
    const ordered = toOrderedParts(individual, parts);
    const grain = ordered.find((o) => o.part.id === 'grain');
    const free = ordered.find((o) => o.part.id === 'free');
    expect([0, PI]).toContain(grain?.rotation);
    expect(free?.rotation).toBe(HALF_PI); // unconstrained gene preserved
  });

  it('treats an omitted grainConstraint the same as unconstrained', () => {
    const part: Part = {
      id: 'u',
      name: 'u',
      polygons: [
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
      ],
      sourceIndex: 0,
    };
    const individual: Individual = {
      rotations: [HALF_PI],
      order: [0],
      mirrors: [false],
      fitness: 0,
      placement: [],
    };
    expect(toOrderedParts(individual, [part])[0].rotation).toBe(HALF_PI);
  });
});

describe('optimize only ever places a grain-constrained part at 0°/180° (integration)', () => {
  it('produces rotation ∈ {0, π} for every placed instance of a grain part', () => {
    const sheet = { width: 200, height: 200 };
    for (let s = 1; s <= 20; s++) {
      seedRandom(s * 6151);
      const parts = [
        makePart('G', 40, 12, true),
        makePart('G', 40, 12, true),
        makePart('f1', 25, 25, false),
        makePart('f2', 18, 30, false),
      ];
      const placed = optimize(parts, sheet, 0, fastConfig);
      const grainPlaced = placed.filter((p) => p.part.id === 'G');
      expect(grainPlaced.length).toBeGreaterThan(0);
      for (const p of grainPlaced) {
        const r = ((p.rotation % (2 * PI)) + 2 * PI) % (2 * PI);
        expect(r === 0 || Math.abs(r - PI) < 1e-9).toBe(true);
      }
    }
  });
});

describe('grainConstraint survives engine transforms', () => {
  it('a placed instance of a grain part keeps its flag and a 0°/180° rotation after nestParts', () => {
    seedRandom(54321);
    const parts = [makePart('G', 40, 20, true), makePart('f', 20, 20, false)];
    const quantities = new Map<string, number>([
      ['G', 3],
      ['f', 2],
    ]);
    const result = nestParts({
      parts,
      quantities,
      config: {
        sheet: { width: 300, height: 300 },
        kerf: 1,
        rotationSteps: 8,
        populationSize: 10,
        generations: 5,
        useNfpPlacement: false,
      },
    });
    const grainPlaced = result.sheets
      .flatMap((sh) => sh.placed)
      .filter((p) => p.part.id.startsWith('G_'));
    expect(grainPlaced.length).toBeGreaterThan(0);
    for (const p of grainPlaced) {
      expect(p.part.grainConstraint).toBe(true);
      const r = ((p.rotation % (2 * PI)) + 2 * PI) % (2 * PI);
      expect(r === 0 || Math.abs(r - PI) < 1e-9).toBe(true);
    }
  });
});
