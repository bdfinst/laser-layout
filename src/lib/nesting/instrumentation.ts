/**
 * Opt-in NFP placement instrumentation (diagnostic for epic #24 / #26).
 *
 * Two questions about why the NFP placement path plateaus on lego-shelves:
 *   1. How often does `orbitingNFP` fail to close (returns null)? Each null silently
 *      downgrades that pair to the bbox/concavity anchors and the true-shape collision,
 *      losing the deep concave seats — so a high null-rate means robustness work in
 *      `orbiting-nfp.ts` moves the KPI directly.
 *   2. How often does `tryAdjacentPositions` exhaust its VALIDATE_BUDGET while candidates
 *      remain (the cap "bites")? A high bite-rate means the genuinely tightest seat can be
 *      truncated away before it is validated — a correctness compromise an exact NFP-union
 *      feasible region would not make.
 *
 * Disabled by default. Every record* call early-returns on the `enabled` flag, so when off
 * the hot paths are byte-for-byte unchanged (no allocation, no branch beyond one boolean).
 * The bench flips it on around a measured run and reads the snapshot.
 */

interface Counters {
  nfpNullComputes: number;
  nfpTotalComputes: number;
  // Budget outcomes split by collision path: the exact/NFP path (nfpCtx present) is the one
  // #26 cares about; the fast bbox phase is reported separately so the two don't blur.
  biteNfp: number;
  okNfp: number;
  biteFast: number;
  okFast: number;
}

let enabled = false;
const counters: Counters = {
  nfpNullComputes: 0,
  nfpTotalComputes: 0,
  biteNfp: 0,
  okNfp: 0,
  biteFast: 0,
  okFast: 0,
};

export function enableNfpInstrumentation(): void {
  enabled = true;
  resetNfpInstrumentation();
}

export function disableNfpInstrumentation(): void {
  enabled = false;
}

export function resetNfpInstrumentation(): void {
  counters.nfpNullComputes = 0;
  counters.nfpTotalComputes = 0;
  counters.biteNfp = 0;
  counters.okNfp = 0;
  counters.biteFast = 0;
  counters.okFast = 0;
}

/** Record the outcome of one real (cache-miss) NFP computation. */
export function recordNfpCompute(isNull: boolean): void {
  if (!enabled) return;
  counters.nfpTotalComputes++;
  if (isNull) counters.nfpNullComputes++;
}

/** Record whether one `tryAdjacentPositions` call hit its validate cap with candidates left. */
export function recordBudgetOutcome(bit: boolean, nfpPath: boolean): void {
  if (!enabled) return;
  if (nfpPath) {
    if (bit) counters.biteNfp++;
    else counters.okNfp++;
  } else {
    if (bit) counters.biteFast++;
    else counters.okFast++;
  }
}

export interface NfpInstrumentationSnapshot extends Counters {
  /** Fraction of unique pair-orbits that failed to close. */
  nullRate: number;
  /** Fraction of exact/NFP-path placements where the validate cap truncated candidates. */
  biteRateNfp: number;
  /** Fraction of fast-path placements where the validate cap truncated candidates. */
  biteRateFast: number;
}

export function nfpInstrumentationSnapshot(): NfpInstrumentationSnapshot {
  const nfpCalls = counters.biteNfp + counters.okNfp;
  const fastCalls = counters.biteFast + counters.okFast;
  return {
    ...counters,
    nullRate:
      counters.nfpTotalComputes > 0 ? counters.nfpNullComputes / counters.nfpTotalComputes : 0,
    biteRateNfp: nfpCalls > 0 ? counters.biteNfp / nfpCalls : 0,
    biteRateFast: fastCalls > 0 ? counters.biteFast / fastCalls : 0,
  };
}
