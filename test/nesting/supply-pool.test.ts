import { describe, it, expect } from 'vitest';
import { createSupplyPool } from '$lib/nesting/supply-pool';
import { availableSheets, type MaterialSheet, type NestingConfig } from '$lib/geometry/types';

const base: Omit<NestingConfig, 'sheet' | 'sheets'> = {
  kerf: 0,
  rotationSteps: 4,
  populationSize: 5,
  generations: 3,
};

describe('SupplyPool', () => {
  it('reports every size as in-supply when constructed from uncapped sizes', () => {
    const sizes: MaterialSheet[] = [
      { width: 100, height: 100 },
      { width: 200, height: 50 },
    ];
    const pool = createSupplyPool(sizes);
    expect(pool.inSupplySizes()).toEqual(sizes);
    expect(pool.isExhausted()).toBe(false);
  });

  it('treats an omitted maxCount as unlimited (never exhausts on decrement)', () => {
    const sizes: MaterialSheet[] = [{ width: 100, height: 100 }];
    const pool = createSupplyPool(sizes);
    for (let i = 0; i < 1000; i++) pool.decrement(sizes[0]);
    expect(pool.inSupplySizes()).toEqual(sizes);
    expect(pool.isExhausted()).toBe(false);
  });

  it('drops a size from in-supply once its maxCount is consumed', () => {
    const sizes: MaterialSheet[] = [{ width: 100, height: 100, maxCount: 2 }];
    const pool = createSupplyPool(sizes);
    pool.decrement(sizes[0]);
    expect(pool.inSupplySizes()).toEqual(sizes);
    pool.decrement(sizes[0]);
    expect(pool.inSupplySizes()).toEqual([]);
    expect(pool.isExhausted()).toBe(true);
  });

  it('tracks supply per size by identity, not by dimensions', () => {
    // Two DISTINCT size objects that share width/height but have separate caps.
    const a: MaterialSheet = { width: 100, height: 100, maxCount: 1 };
    const b: MaterialSheet = { width: 100, height: 100, maxCount: 1 };
    const pool = createSupplyPool([a, b]);
    pool.decrement(a);
    // Consuming `a` must not exhaust `b` even though their dimensions match.
    expect(pool.inSupplySizes()).toEqual([b]);
    expect(pool.isExhausted()).toBe(false);
    pool.decrement(b);
    expect(pool.inSupplySizes()).toEqual([]);
    expect(pool.isExhausted()).toBe(true);
  });

  it('builds from availableSheets(config) and honors per-size caps', () => {
    const config: NestingConfig = {
      ...base,
      sheet: { width: 1, height: 1 },
      sheets: [
        { width: 600, height: 350, maxCount: 1 },
        { width: 500, height: 400 },
      ],
    };
    const sizes = availableSheets(config);
    const pool = createSupplyPool(sizes);
    pool.decrement(sizes[0]);
    // First size exhausted (cap 1); the uncapped second size remains.
    expect(pool.inSupplySizes()).toEqual([sizes[1]]);
    expect(pool.isExhausted()).toBe(false);
  });

  it('throws (with a distinct message) when decrementing a size not in the pool', () => {
    const pool = createSupplyPool([{ width: 100, height: 100 }]);
    expect(() => pool.decrement({ width: 50, height: 50 })).toThrow(/not part of this pool/);
  });

  it('throws (with a distinct message) when decrementing an already-exhausted size', () => {
    const sizes: MaterialSheet[] = [{ width: 100, height: 100, maxCount: 1 }];
    const pool = createSupplyPool(sizes);
    pool.decrement(sizes[0]);
    expect(() => pool.decrement(sizes[0])).toThrow(/already exhausted/);
  });

  it('treats a maxCount of 0 as born-exhausted', () => {
    const sizes: MaterialSheet[] = [{ width: 100, height: 100, maxCount: 0 }];
    const pool = createSupplyPool(sizes);
    expect(pool.inSupplySizes()).toEqual([]);
    expect(pool.isExhausted()).toBe(true);
    // A zero-cap size has nothing to consume — decrement fails immediately.
    expect(() => pool.decrement(sizes[0])).toThrow(/already exhausted/);
  });

  it('reports total remaining supply, Infinity when any size is unlimited', () => {
    const capped = createSupplyPool([
      { width: 1, height: 1, maxCount: 2 },
      { width: 2, height: 2, maxCount: 3 },
    ]);
    expect(capped.totalRemaining()).toBe(5);

    const mixed = createSupplyPool([
      { width: 1, height: 1, maxCount: 2 },
      { width: 2, height: 2 },
    ]);
    expect(mixed.totalRemaining()).toBe(Infinity);
  });

  it('lowers the total remaining as supply is consumed', () => {
    const sizes: MaterialSheet[] = [{ width: 1, height: 1, maxCount: 2 }];
    const pool = createSupplyPool(sizes);
    expect(pool.totalRemaining()).toBe(2);
    pool.decrement(sizes[0]);
    expect(pool.totalRemaining()).toBe(1);
  });

  it('rejects a size list containing the SAME object reference twice', () => {
    // The same reference would collapse to one index and miscount supply, so it is rejected.
    const shared: MaterialSheet = { width: 100, height: 100 };
    expect(() => createSupplyPool([shared, shared])).toThrow(/duplicate/i);
  });

  it('still allows distinct objects that happen to share dimensions', () => {
    const a: MaterialSheet = { width: 100, height: 100 };
    const b: MaterialSheet = { width: 100, height: 100 };
    expect(() => createSupplyPool([a, b])).not.toThrow();
  });
});
