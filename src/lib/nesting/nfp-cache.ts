import type { Polygon } from '$lib/geometry/types';
import { orbitingNFP } from './orbiting-nfp';
import { recordNfpCompute } from './instrumentation';

/**
 * Per-pair No-Fit-Polygon cache (epic #24, phase P2).
 *
 * An NFP depends only on the two *shapes* and their rotations — never on where either
 * part sits — so it is translation-invariant: one computation per `(partA, rotA, partB,
 * rotB)` serves every placement evaluation in the GA, which is what makes NFP-based
 * placement (P3) and point-in-NFP collision (P5) affordable. Parts are deduplicated and
 * rotations are discrete (`rotationSteps`), so the key space is bounded; a simple
 * insertion-order eviction caps memory.
 *
 * Not yet wired into the engine — landed behind tests with no behavior change.
 */

export interface NfpCacheKey {
  partA: string;
  rotA: number;
  partB: string;
  rotB: number;
}

export function nfpCacheKey(k: NfpCacheKey): string {
  return `${k.partA}@${k.rotA}|${k.partB}@${k.rotB}`;
}

export interface NfpCache {
  /** Number of cached entries (including computed `null` failures). */
  readonly size: number;
  /** How many `compute` calls were served from the cache rather than recomputed. */
  readonly hits: number;
  /** How many `compute` calls fell through to an actual NFP computation. */
  readonly misses: number;
  /**
   * Return the NFP for the keyed shape pair, computing (and caching) it on first use.
   * `a`/`b` must be the actual rotated polygons matching the key. `null` is cached too,
   * so a pair whose orbit fails to close isn't retried every evaluation.
   */
  get(key: NfpCacheKey, a: Polygon, b: Polygon): Polygon | null;
  has(key: NfpCacheKey): boolean;
  /**
   * Per-pair side cache for the kerf-dilated NFP used by the feasible-region placement path
   * (#26). The dilation depends only on the shape pair and the (per-nest constant) kerf, so it
   * is translation-invariant and amortizes across every placement and GA generation — the
   * expensive InflatePaths + simplify runs once per pair, not once per placement. Values are
   * clipper `Paths64` at the pair's local origin; the placement layer owns the clipper types,
   * so this is typed loosely to keep the cache clipper-agnostic.
   */
  readonly dilated: Map<string, unknown>;
  clear(): void;
}

const DEFAULT_MAX_ENTRIES = 8192;

export function createNfpCache(
  maxEntries = DEFAULT_MAX_ENTRIES,
  compute: (a: Polygon, b: Polygon) => Polygon | null = orbitingNFP,
): NfpCache {
  const map = new Map<string, Polygon | null>();
  const dilated = new Map<string, unknown>();
  let hits = 0;
  let misses = 0;

  return {
    dilated,
    get size() {
      return map.size;
    },
    get hits() {
      return hits;
    },
    get misses() {
      return misses;
    },
    has(key) {
      return map.has(nfpCacheKey(key));
    },
    get(key, a, b) {
      const k = nfpCacheKey(key);
      const cached = map.get(k);
      if (cached !== undefined || map.has(k)) {
        hits++;
        return cached ?? null;
      }
      misses++;
      const nfp = compute(a, b);
      recordNfpCompute(nfp === null);
      if (map.size >= maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      map.set(k, nfp);
      return nfp;
    },
    clear() {
      map.clear();
      dilated.clear();
      hits = 0;
      misses = 0;
    },
  };
}
