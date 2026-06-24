import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { nestParts } from '$lib/nesting/engine';
import { makeRect } from '../support/parts';
import { seedRandom, restoreRandom } from '../support/seeded-random';
import type { NestingConfig } from '$lib/geometry/types';

const makePart = (id: string, w: number, h: number, priority?: 'required' | 'optional') =>
  makeRect(id, w, h, { priority });

const baseConfig: NestingConfig = {
  sheet: { width: 100, height: 100 },
  kerf: 1,
  rotationSteps: 8,
  populationSize: 10,
  generations: 5,
  useNfpPlacement: false,
};

beforeEach(() => seedRandom(13579));
afterEach(() => restoreRandom());

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
