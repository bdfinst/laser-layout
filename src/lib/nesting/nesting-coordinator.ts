import { isBetterResult, type NestingResult } from './engine';
import type { WorkerResponse } from './nesting-worker';

/**
 * Parallel multi-start coordinator (#42). Multi-start nesting is embarrassingly parallel — each
 * start is an independent search whose only interaction is "keep the best". This module runs a
 * pool of nesting workers, each driving the serial `nestPartsMultiStartIterative` with its own
 * (browser-global, naturally divergent) RNG, and aggregates their best layouts with the same
 * `isBetterResult` the serial loop uses.
 *
 * In a fixed wall-clock budget N workers complete ≈ N× as many starts as one, and the aggregate
 * is the best across all of them — so the parallel result is never worse than serial and almost
 * always benefits from the extra starts. The worker plumbing is injected (`WorkerFactory`) so the
 * pure orchestration is unit-testable without real Web Workers.
 */

/** Minimal structural subset of `Worker` the coordinator depends on (real Worker satisfies it). */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: { data: WorkerResponse }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type WorkerFactory = () => WorkerLike;

export interface CoordinatorHandlers {
  /** Best-so-far progress across all workers (result is already the global best). */
  onProgress: (currentSheet: number, generation: number, result: NestingResult) => void;
  /** All workers finished (or failed after producing a result); `result` is the global best. */
  onDone: (result: NestingResult, totalStarts: number) => void;
  /** Every worker failed before producing any result. */
  onError: (message: string) => void;
}

export interface CoordinatorHandle {
  /** Terminate every worker and ignore any further messages (Stop / teardown). */
  terminate(): void;
}

/**
 * Grace added to the time budget before the coordinator force-finishes (#42). Workers self-stop
 * at the budget on their own GA-generation boundaries; this small margin lets a normal run report
 * `done` first and only cuts off a genuine straggler (one stuck mid exact/NFP generation).
 */
export const COORDINATOR_GRACE_MS = 2000;

/**
 * Pick the strictly-better of two results (keeping `a` on ties) using the engine's policy.
 * Exposed so the aggregation invariant — the merged result is never worse than any input — is
 * directly unit-testable.
 */
export function mergeBest(a: NestingResult | null, b: NestingResult): NestingResult {
  if (!a) return b;
  return isBetterResult(b, a) ? b : a;
}

/**
 * Resolve how many workers to spawn: one per logical core *less one reserved for the main
 * thread*, clamped to [1, cap]. Reserving a core keeps the main thread responsive — it still
 * has to process progress messages, update the UI, and fire the wall-clock cutoff timer; a
 * fully-subscribed pool can starve it on a busy/shared machine (e.g. CI), delaying both the
 * cutoff and the workers' `done` messages and hanging the run well past its budget. A 1–2 core
 * machine degrades cleanly to a single worker (= serial behaviour).
 */
export function desiredWorkerCount(hardwareConcurrency: number | undefined, cap = 8): number {
  const cores = Number.isFinite(hardwareConcurrency)
    ? Math.floor(hardwareConcurrency as number)
    : 1;
  return Math.max(1, Math.min(cap, cores - 1));
}

export interface ParallelNestOptions {
  /**
   * Global wall-clock cutoff (ms). Each worker also self-enforces this budget, but the slowest of
   * N workers gates completion and a single slow exact/NFP generation can overrun the boundary, so
   * the coordinator caps total wall-clock at `timeBudgetMs + COORDINATOR_GRACE_MS`, delivering the
   * best layout found so far and terminating any straggler. Omit to wait for every worker (tests).
   */
  timeBudgetMs?: number;
  /** Injectable timer for tests (defaults to setTimeout/clearTimeout). */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Spawn `count` workers, post the same serialized input to each, and aggregate their results.
 * Returns immediately with a handle whose `terminate()` stops the pool; results are delivered
 * through `handlers`.
 */
export function runParallelNest(
  serializedInput: unknown,
  count: number,
  factory: WorkerFactory,
  handlers: CoordinatorHandlers,
  options: ParallelNestOptions = {},
): CoordinatorHandle {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));

  const workers: WorkerLike[] = [];
  let best: NestingResult | null = null;
  let finished = 0;
  let totalStarts = 0;
  let stopped = false;
  let done = false;
  // Set once the cutoff fires before any layout exists: finish the instant the first result lands.
  let forceFinish = false;
  let lastError = 'Nesting failed';
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearCutoff = (): void => {
    if (timer != null) {
      clearTimer(timer);
      timer = null;
    }
  };

  // Deliver the aggregate result exactly once and stop every worker (including stragglers).
  const finalize = (): void => {
    if (done) return;
    done = true;
    clearCutoff();
    for (const worker of workers) worker.terminate();
    if (best) handlers.onDone(best, totalStarts);
    else handlers.onError(lastError);
  };

  const finishOne = (): void => {
    finished++;
    if (finished >= count) finalize();
  };

  for (let i = 0; i < count; i++) {
    const worker = factory();
    workers.push(worker);

    worker.onmessage = (event) => {
      if (stopped || done) return;
      const msg = event.data;
      if (msg.type === 'progress') {
        best = mergeBest(best, msg.result);
        if (forceFinish) {
          finalize();
          return;
        }
        handlers.onProgress(msg.currentSheet, msg.generation, best);
      } else if (msg.type === 'done') {
        best = mergeBest(best, msg.result);
        totalStarts += msg.starts;
        if (forceFinish) {
          finalize();
          return;
        }
        finishOne();
      } else if (msg.type === 'error') {
        // A failed worker still lets the pool succeed on the others' results.
        lastError = msg.message;
        finishOne();
      }
    };

    worker.onerror = (event) => {
      if (stopped || done) return;
      lastError = event instanceof Error ? event.message : 'Nesting worker error';
      finishOne();
    };

    worker.postMessage({ type: 'start', input: serializedInput });
  }

  if (options.timeBudgetMs != null && options.timeBudgetMs >= 0) {
    timer = setTimer(() => {
      timer = null;
      // Best-so-far already exists (the fast GA phase reports it within a generation or two): cut
      // off stragglers now. Otherwise arm forceFinish so the first result to arrive finalizes.
      if (best) finalize();
      else forceFinish = true;
    }, options.timeBudgetMs + COORDINATOR_GRACE_MS);
  }

  return {
    terminate(): void {
      stopped = true;
      done = true;
      clearCutoff();
      for (const worker of workers) worker.terminate();
    },
  };
}
