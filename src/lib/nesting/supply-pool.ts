import type { MaterialSheet } from '$lib/geometry/types';

/**
 * Tracks the remaining supply of each available sheet size during a nest.
 *
 * Built from `availableSheets(config)`, it owns the per-size remaining-count state so the
 * three sheet-opening loops (`nestPartsIterative`, `nestParts`, `packIntoKSheets`) never
 * copy-paste a counter. A size's `maxCount` is its supply; an omitted `maxCount` is unlimited
 * (`Infinity`). Supply is keyed by the `MaterialSheet` IDENTITY (its position in the list),
 * NOT by width/height — two distinct configured sizes may share dimensions yet have separate
 * caps, and consuming one must not deplete the other.
 */
export interface SupplyPool {
  /** Sizes that still have remaining supply (> 0), in original order, by identity. */
  inSupplySizes(): MaterialSheet[];
  /** Consume one sheet of the given size. Throws if it is not in the pool or already exhausted. */
  decrement(sheet: MaterialSheet): void;
  /** True when no size has any remaining supply. */
  isExhausted(): boolean;
  /** Total remaining supply across all sizes; `Infinity` when any size is unlimited. */
  totalRemaining(): number;
}

/** Build a {@link SupplyPool} from an available-size list (omitted `maxCount` ⇒ unlimited). */
export function createSupplyPool(sizes: MaterialSheet[]): SupplyPool {
  // Supply is keyed by object identity (list position). The same reference appearing twice would
  // collapse to one index and silently miscount its supply, so reject it. Distinct objects that
  // happen to share dimensions are fine — that is exactly the identity feature.
  if (new Set(sizes).size !== sizes.length) {
    throw new Error('SupplyPool: duplicate sheet reference in the size list');
  }
  const remaining = sizes.map((s) => s.maxCount ?? Infinity);

  return {
    inSupplySizes: () => sizes.filter((_, i) => remaining[i] > 0),
    decrement: (sheet) => {
      const i = sizes.indexOf(sheet);
      if (i < 0) throw new Error('SupplyPool.decrement: sheet is not part of this pool');
      if (remaining[i] <= 0) throw new Error('SupplyPool.decrement: size already exhausted');
      remaining[i] -= 1;
    },
    isExhausted: () => remaining.every((r) => r <= 0),
    totalRemaining: () => remaining.reduce((sum, r) => sum + r, 0),
  };
}
