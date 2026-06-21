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
 * Pick the strictly-better of two results (keeping `a` on ties) using the engine's policy.
 * Exposed so the aggregation invariant — the merged result is never worse than any input — is
 * directly unit-testable.
 */
export function mergeBest(a: NestingResult | null, b: NestingResult): NestingResult {
  if (!a) return b;
  return isBetterResult(b, a) ? b : a;
}

/**
 * Resolve how many workers to spawn: one per logical core (the caller passes
 * `navigator.hardwareConcurrency`), clamped to [1, cap] so we neither under-use a multi-core
 * machine nor oversubscribe a many-core one. A value of 1 degrades cleanly to serial behaviour.
 */
export function desiredWorkerCount(hardwareConcurrency: number | undefined, cap = 8): number {
  const cores = Number.isFinite(hardwareConcurrency)
    ? Math.floor(hardwareConcurrency as number)
    : 1;
  return Math.max(1, Math.min(cap, cores));
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
): CoordinatorHandle {
  const workers: WorkerLike[] = [];
  let best: NestingResult | null = null;
  let finished = 0;
  let totalStarts = 0;
  let stopped = false;
  let lastError = 'Nesting failed';

  const finishOne = (): void => {
    finished++;
    if (finished < count) return;
    if (best) handlers.onDone(best, totalStarts);
    else handlers.onError(lastError);
  };

  for (let i = 0; i < count; i++) {
    const worker = factory();
    workers.push(worker);

    worker.onmessage = (event) => {
      if (stopped) return;
      const msg = event.data;
      if (msg.type === 'progress') {
        best = mergeBest(best, msg.result);
        handlers.onProgress(msg.currentSheet, msg.generation, best);
      } else if (msg.type === 'done') {
        best = mergeBest(best, msg.result);
        totalStarts += msg.starts;
        finishOne();
      } else if (msg.type === 'error') {
        // A failed worker still lets the pool succeed on the others' results.
        lastError = msg.message;
        finishOne();
      }
    };

    worker.onerror = (event) => {
      if (stopped) return;
      lastError = event instanceof Error ? event.message : 'Nesting worker error';
      finishOne();
    };

    worker.postMessage({ type: 'start', input: serializedInput });
  }

  return {
    terminate(): void {
      stopped = true;
      for (const worker of workers) worker.terminate();
    },
  };
}
