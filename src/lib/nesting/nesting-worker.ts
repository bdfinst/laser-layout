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

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;
  if (msg.type !== 'start') return;

  try {
    const input: NestingInput = {
      ...msg.input,
      quantities: rehydrateQuantities(msg.input.quantities),
    };

    // Multi-start nesting (the engine owns all restart/best-keeping/early-stop policy). The
    // worker just drives the generator, reporting best-so-far progress and enforcing the
    // wall-clock budget between generations — so a single long start can still be cut off
    // and the best layout so far returned, rather than nothing.
    const deadline = Date.now() + resolveTimeBudget(input.config);
    const gen = nestPartsMultiStartIterative(input);
    let lastResult: NestingResult | null = null;
    let lastStarts = 0;

    function step() {
      try {
        if (Date.now() >= deadline && lastResult) {
          self.postMessage({
            type: 'done',
            result: lastResult,
            starts: lastStarts,
          } satisfies WorkerResponse);
          return;
        }

        const iter = gen.next();
        if (iter.done) {
          self.postMessage({
            type: 'done',
            result: iter.value,
            starts: lastStarts,
          } satisfies WorkerResponse);
        } else {
          const progress: NestingProgress = iter.value;
          lastResult = progress.result;
          lastStarts = progress.starts ?? lastStarts;
          self.postMessage({
            type: 'progress',
            currentSheet: progress.currentSheet,
            generation: progress.generation,
            result: progress.result,
            starts: lastStarts,
          } satisfies WorkerResponse);
          setTimeout(step, 0);
        }
      } catch (err) {
        self.postMessage({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        } satisfies WorkerResponse);
      }
    }

    step();
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse);
  }
};
