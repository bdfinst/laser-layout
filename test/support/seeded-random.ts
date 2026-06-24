/**
 * Deterministic RNG for nesting tests.
 *
 * The genetic algorithm draws from `Math.random`, so any test that drives the
 * optimizer/engine must pin the RNG or its assertions (placement counts, fitness
 * ordering, overlap-freedom) become flaky. This is the single canonical MINSTD
 * (Park-Miller, multiplier 16807) generator the nesting suite shares — previously
 * copy-pasted into several files in two divergent forms.
 *
 * Usage:
 *   beforeEach(() => seedRandom());      // default seed 42
 *   afterEach(() => restoreRandom());
 * or, for a specific trajectory: `seedRandom(s * 6151)`.
 */
let original: (() => number) | null = null;

/** Install the deterministic LCG, remembering the real `Math.random` for restore. */
export function seedRandom(seed = 42): void {
  if (original === null) original = Math.random;
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  Math.random = () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

/** Restore the real `Math.random`. Safe to call even if `seedRandom` never ran. */
export function restoreRandom(): void {
  if (original !== null) {
    Math.random = original;
    original = null;
  }
}
