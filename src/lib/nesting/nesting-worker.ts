import {
  nestPartsMultiStartIterative,
  resolveTimeBudget,
  type NestingInput,
  type NestingResult,
  type NestingProgress,
} from './engine';

export type WorkerMessage = { type: 'start'; input: NestingInput };

/**
 * Rehydrate the part-quantities map from its structured-clone-serialized form. `postMessage`
 * may deliver the `Map` as a `Map`, an array of `[id, count]` pairs, or a plain object depending
 * on the browser, so accept all three wire forms (not `NestingInput['quantities']`, which is just
 * `Map`). String values are coerced via `Number(...)` exactly as before — a non-numeric string
 * therefore yields `NaN`. A `Map` input is returned as a copy, never the original reference.
 */
export function rehydrateQuantities(
  raw: Map<string, number> | readonly [string, number][] | Record<string, number | string>,
): Map<string, number> {
  if (raw instanceof Map) return new Map(raw);
  if (Array.isArray(raw)) return new Map(raw);
  return new Map(
    Object.entries(raw as Record<string, number | string>).map(([k, v]) => [k, Number(v)]),
  );
}

export type WorkerResponse =
  | {
      type: 'progress';
      currentSheet: number;
      generation: number;
      result: NestingResult;
      starts: number;
    }
  | { type: 'done'; result: NestingResult; starts: number }
  | { type: 'error'; message: string };

/**
 * The side-effect boundary `runWorkerLoop` drives. The real worker injects `self.postMessage`,
 * `Date.now`, `setTimeout`, and the real generator factory; tests inject controllable fakes so the
 * drive/budget/error logic is verified without a real Worker, clock, or timer. `run` defaults to the
 * real `nestPartsMultiStartIterative`, so production callers pass only the three boundary functions.
 */
export interface WorkerLoopDeps {
  post: (msg: WorkerResponse) => void;
  now: () => number;
  schedule: (fn: () => void) => void;
  run?: (input: NestingInput) => Generator<NestingProgress, NestingResult>;
}

/**
 * Drive the multi-start nesting generator, posting best-so-far progress and enforcing the wall-clock
 * budget between generations (a single long start can still be cut off and the best layout so far
 * returned, rather than nothing). The engine owns all restart/best-keeping/early-stop policy.
 */
export function runWorkerLoop(rawInput: NestingInput, deps: WorkerLoopDeps): void {
  const { post, now, schedule } = deps;
  const run = deps.run ?? nestPartsMultiStartIterative;

  try {
    const input: NestingInput = {
      ...rawInput,
      quantities: rehydrateQuantities(rawInput.quantities),
    };

    const deadline = now() + resolveTimeBudget(input.config);
    const gen = run(input);
    let lastResult: NestingResult | null = null;
    let lastStarts = 0;

    function step() {
      try {
        if (now() >= deadline && lastResult) {
          post({ type: 'done', result: lastResult, starts: lastStarts });
          return;
        }

        const iter = gen.next();
        if (iter.done) {
          post({ type: 'done', result: iter.value, starts: lastStarts });
        } else {
          const progress: NestingProgress = iter.value;
          lastResult = progress.result;
          lastStarts = progress.starts ?? lastStarts;
          post({
            type: 'progress',
            currentSheet: progress.currentSheet,
            generation: progress.generation,
            result: progress.result,
            starts: lastStarts,
          });
          schedule(step);
        }
      } catch (err) {
        post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    }

    step();
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

/** Adapter from a worker message to the loop: ignore anything but `start`, else drive the loop. */
export function handleMessage(data: WorkerMessage, deps: WorkerLoopDeps): void {
  if (data.type !== 'start') return;
  runWorkerLoop(data.input, deps);
}

// Only wire the global handler inside a real worker scope; guarded so importing this module in a
// test/SSR environment without `self` never throws (the extracted functions are tested directly).
if (typeof self !== 'undefined') {
  self.onmessage = (e: MessageEvent<WorkerMessage>) =>
    handleMessage(e.data, {
      post: (m) => self.postMessage(m),
      now: () => Date.now(),
      schedule: (fn) => setTimeout(fn, 0),
    });
}
