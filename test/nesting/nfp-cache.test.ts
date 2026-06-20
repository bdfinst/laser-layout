import { describe, it, expect, vi } from 'vitest';
import { createNfpCache, nfpCacheKey } from '$lib/nesting/nfp-cache';
import { orbitingNFP } from '$lib/nesting/orbiting-nfp';
import type { Polygon } from '$lib/geometry/types';

const Lshape: Polygon = [
  { x: 0, y: 0 },
  { x: 6, y: 0 },
  { x: 6, y: 2 },
  { x: 2, y: 2 },
  { x: 2, y: 6 },
  { x: 0, y: 6 },
];

const tri: Polygon = [
  { x: 0, y: 0 },
  { x: 5, y: 0 },
  { x: 2.5, y: 5 },
];

describe('nfpCacheKey', () => {
  it('is stable and order-sensitive in the pair', () => {
    const k = { partA: 'p1', rotA: 0, partB: 'p2', rotB: 3 };
    expect(nfpCacheKey(k)).toBe('p1@0|p2@3');
    expect(nfpCacheKey({ ...k, partA: 'p2', partB: 'p1', rotA: 3, rotB: 0 })).not.toBe(
      nfpCacheKey(k),
    );
  });
});

describe('createNfpCache', () => {
  it('computes once per key and serves repeats from cache', () => {
    const compute = vi.fn(orbitingNFP);
    const cache = createNfpCache(100, compute);
    const key = { partA: 'L', rotA: 0, partB: 'T', rotB: 0 };

    const first = cache.get(key, Lshape, tri);
    const second = cache.get(key, Lshape, tri);

    expect(compute).toHaveBeenCalledTimes(1);
    expect(cache.misses).toBe(1);
    expect(cache.hits).toBe(1);
    expect(second).toBe(first); // same cached reference
  });

  it('translation-invariance: cached result equals a fresh compute', () => {
    const cache = createNfpCache();
    const cached = cache.get({ partA: 'L', rotA: 0, partB: 'T', rotB: 0 }, Lshape, tri);
    const fresh = orbitingNFP(Lshape, tri);
    expect(cached).toEqual(fresh);
  });

  it('distinguishes rotations and parts via the key', () => {
    const compute = vi.fn(orbitingNFP);
    const cache = createNfpCache(100, compute);
    cache.get({ partA: 'L', rotA: 0, partB: 'T', rotB: 0 }, Lshape, tri);
    cache.get({ partA: 'L', rotA: 1, partB: 'T', rotB: 0 }, Lshape, tri);
    cache.get({ partA: 'L', rotA: 0, partB: 'T', rotB: 2 }, Lshape, tri);
    expect(compute).toHaveBeenCalledTimes(3);
    expect(cache.size).toBe(3);
  });

  it('caches null (failed orbit) so it is not recomputed', () => {
    const compute = vi.fn(() => null);
    const cache = createNfpCache(100, compute);
    const key = { partA: 'A', rotA: 0, partB: 'B', rotB: 0 };
    expect(cache.get(key, Lshape, tri)).toBeNull();
    expect(cache.get(key, Lshape, tri)).toBeNull();
    expect(compute).toHaveBeenCalledTimes(1);
    expect(cache.hits).toBe(1);
  });

  it('evicts oldest entries past the bound', () => {
    const cache = createNfpCache(2);
    cache.get({ partA: 'a', rotA: 0, partB: 'b', rotB: 0 }, Lshape, tri);
    cache.get({ partA: 'c', rotA: 0, partB: 'd', rotB: 0 }, Lshape, tri);
    cache.get({ partA: 'e', rotA: 0, partB: 'f', rotB: 0 }, Lshape, tri);
    expect(cache.size).toBe(2);
    expect(cache.has({ partA: 'a', rotA: 0, partB: 'b', rotB: 0 })).toBe(false);
    expect(cache.has({ partA: 'e', rotA: 0, partB: 'f', rotB: 0 })).toBe(true);
  });

  it('clear resets entries and counters', () => {
    const cache = createNfpCache();
    cache.get({ partA: 'a', rotA: 0, partB: 'b', rotB: 0 }, Lshape, tri);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.hits).toBe(0);
    expect(cache.misses).toBe(0);
  });
});
