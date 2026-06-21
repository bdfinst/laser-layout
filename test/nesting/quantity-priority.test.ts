import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { nestParts } from '$lib/nesting/engine';
import type { Part, NestingConfig } from '$lib/geometry/types';

function makePart(id: string, w: number, h: number, priority?: 'required' | 'optional'): Part {
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
    priority,
  };
}

const baseConfig: NestingConfig = {
  sheet: { width: 100, height: 100 },
  kerf: 1,
  rotationSteps: 8,
  populationSize: 10,
  generations: 5,
  useNfpPlacement: false,
};

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
  seedRandom(13579);
});
afterEach(() => {
  Math.random = origRandom;
});

describe('quantity priority: optional parts are dropped instead of overflowing', () => {
  it('drops an optional part that does not fit beside the required part (1 sheet, not 2)', () => {
    // R (95x95) nearly fills the 100x100 sheet; O (60x60) cannot also fit on it.
    const parts = [makePart('R', 95, 95, 'required'), makePart('O', 60, 60, 'optional')];
    const quantities = new Map<string, number>([
      ['R', 1],
      ['O', 1],
    ]);

    const result = nestParts({ parts, quantities, config: baseConfig });

    expect(result.sheets).toHaveLength(1);
    expect(result.totalPlaced).toBe(1);
    // The dropped copy is reported as unplaced, restored to its original geometry.
    expect(result.unplaced.map((p) => p.id)).toContain('O_0');
  });

  it('control: marking the same part required overflows to a second sheet', () => {
    const parts = [makePart('R', 95, 95, 'required'), makePart('O', 60, 60, 'required')];
    const quantities = new Map<string, number>([
      ['R', 1],
      ['O', 1],
    ]);

    const result = nestParts({ parts, quantities, config: baseConfig });

    expect(result.sheets).toHaveLength(2);
    expect(result.totalPlaced).toBe(2);
    expect(result.unplaced).toHaveLength(0);
  });

  it('still places optional parts that fit alongside required ones (ride-along)', () => {
    // A wide sheet fits both 90x90 squares side by side.
    const parts = [makePart('R', 90, 90, 'required'), makePart('O', 90, 90, 'optional')];
    const quantities = new Map<string, number>([
      ['R', 1],
      ['O', 1],
    ]);

    const result = nestParts({
      parts,
      quantities,
      config: { ...baseConfig, sheet: { width: 200, height: 100 } },
    });

    expect(result.sheets).toHaveLength(1);
    expect(result.totalPlaced).toBe(2);
    expect(result.unplaced).toHaveLength(0);
  });

  it('an all-optional job keeps normal overflow (no required parts to anchor the sheet budget)', () => {
    const parts = [makePart('A', 95, 95, 'optional'), makePart('B', 95, 95, 'optional')];
    const quantities = new Map<string, number>([
      ['A', 1],
      ['B', 1],
    ]);

    const result = nestParts({ parts, quantities, config: baseConfig });

    expect(result.sheets).toHaveLength(2);
    expect(result.totalPlaced).toBe(2);
    expect(result.unplaced).toHaveLength(0);
  });
});
