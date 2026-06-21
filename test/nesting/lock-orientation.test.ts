import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  optimize,
  toOrderedParts,
  DEFAULT_OPTIMIZER_CONFIG,
  type Individual,
} from '$lib/nesting/optimizer';
import { nestParts } from '$lib/nesting/engine';
import type { Part } from '$lib/geometry/types';

function makePart(id: string, w: number, h: number, lockOrientation = false): Part {
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
    lockOrientation,
  };
}

const fastConfig = {
  ...DEFAULT_OPTIMIZER_CONFIG,
  populationSize: 12,
  maxGenerations: 6,
  stallWindow: 6,
  stallEpsilon: 0.005,
  // Pinned > 1 so the rotation-freedom assertion is meaningful regardless of the
  // optimizer default (must allow multiple rotations to prove the clamp doesn't
  // accidentally freeze rotation).
  rotationSteps: 8,
};

// Deterministic LCG matching test/nesting/optimizer.test.ts, with a settable seed.
let origRandom: () => number;
function seedRandom(initial: number) {
  let seed = initial % 2147483647;
  if (seed <= 0) seed += 2147483646;
  Math.random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}
beforeEach(() => {
  origRandom = Math.random;
});
afterEach(() => {
  Math.random = origRandom;
});

describe('toOrderedParts honors lockOrientation (consumption-time clamp)', () => {
  it('forces mirror false for a locked part regardless of its mirror gene, keyed by part index', () => {
    const parts = [makePart('locked', 10, 10, true), makePart('free', 10, 10, false)];
    // order maps position -> part index; mirrors are indexed by position.
    const individual: Individual = {
      rotations: [0, 0],
      order: [1, 0], // position 0 -> free(idx1), position 1 -> locked(idx0)
      mirrors: [true, true],
      fitness: 0,
      placement: [],
    };
    const ordered = toOrderedParts(individual, parts);
    const free = ordered.find((o) => o.part.id === 'free');
    const locked = ordered.find((o) => o.part.id === 'locked');
    expect(locked?.mirror).toBe(false); // clamped despite gene true
    expect(free?.mirror).toBe(true); // unlocked gene preserved
  });

  it('preserves mirror genes verbatim when no part is locked (today behavior)', () => {
    const parts = [makePart('a', 10, 10, false), makePart('b', 10, 10, false)];
    const individual: Individual = {
      rotations: [0, 0],
      order: [0, 1],
      mirrors: [true, false],
      fitness: 0,
      placement: [],
    };
    const ordered = toOrderedParts(individual, parts);
    expect(ordered.map((o) => o.mirror)).toEqual([true, false]);
  });

  it('treats an omitted lockOrientation (undefined) the same as unlocked', () => {
    const undefinedLock: Part = {
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
    }; // lockOrientation omitted entirely
    const individual: Individual = {
      rotations: [0],
      order: [0],
      mirrors: [true],
      fitness: 0,
      placement: [],
    };
    expect(toOrderedParts(individual, [undefinedLock])[0].mirror).toBe(true);
  });
});

describe('optimize never mirrors a locked part (integration, fixed seeds)', () => {
  it('produces mirror=false for every placed instance of a locked part, while rotation stays free', () => {
    const sheet = { width: 200, height: 200 };
    const lockedRotations = new Set<number>();

    for (let s = 1; s <= 20; s++) {
      seedRandom(s * 7919);
      // Three instances of a locked part (quantity > 1) plus unlocked filler.
      const parts = [
        makePart('L', 40, 12, true),
        makePart('L', 40, 12, true),
        makePart('L', 40, 12, true),
        makePart('f1', 25, 25, false),
        makePart('f2', 18, 30, false),
      ];
      const placed = optimize(parts, sheet, 0, fastConfig);
      const lockedPlaced = placed.filter((p) => p.part.id === 'L');
      expect(lockedPlaced.length).toBeGreaterThan(0);
      for (const p of lockedPlaced) {
        expect(p.mirror).not.toBe(true);
        lockedRotations.add(Math.round(p.rotation * 1000));
      }
    }
    // Rotation is still optimized — the clamp must not freeze it.
    expect(lockedRotations.size).toBeGreaterThan(1);
  });
});

describe('lockOrientation survives engine transforms (expand / simplify / round-trip)', () => {
  it('a placed instance of a locked part still carries lockOrientation after nestParts', () => {
    seedRandom(12345);
    const parts = [makePart('L', 40, 20, true), makePart('f', 20, 20, false)];
    const quantities = new Map<string, number>([
      ['L', 3],
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
    // expandParts rewrites ids to `${id}_${i}`, so locked instances are L_0, L_1, ...
    const lockedPlaced = result.sheets
      .flatMap((sh) => sh.placed)
      .filter((p) => p.part.id.startsWith('L_'));
    expect(lockedPlaced.length).toBeGreaterThan(0);
    for (const p of lockedPlaced) {
      expect(p.part.lockOrientation).toBe(true);
      expect(p.mirror).not.toBe(true);
    }
  });
});
