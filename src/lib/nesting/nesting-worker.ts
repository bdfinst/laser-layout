import {
  nestPartsIterative,
  type NestingInput,
  type NestingResult,
  type NestingProgress,
} from './engine';

export type WorkerMessage = { type: 'start'; input: NestingInput };

// Default wall-clock budget for a full nest when the config doesn't specify one. The app
// optimizes for density over speed, so it runs the GA until it converges or the budget is
// reached (checked at generation boundaries, so one in-flight generation may run past it),
// then returns the best layout found so far. Configurable via `NestingConfig.timeBudgetMs`.
const DEFAULT_NEST_BUDGET_MS = 60_000;

export type WorkerResponse =
  | { type: 'progress'; currentSheet: number; generation: number; result: NestingResult }
  | { type: 'done'; result: NestingResult }
  | { type: 'error'; message: string };

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;
  if (msg.type !== 'start') return;

  try {
    const raw = msg.input.quantities;
    let entries: [string, number][];
    if (raw instanceof Map) {
      entries = Array.from(raw.entries());
    } else if (Array.isArray(raw)) {
      entries = raw;
    } else {
      entries = Object.entries(raw as Record<string, number>).map(([k, v]) => [k, Number(v)]);
    }

    const input: NestingInput = {
      ...msg.input,
      quantities: new Map(entries),
    };

    const gen = nestPartsIterative(input);
    const budget =
      input.config.timeBudgetMs && input.config.timeBudgetMs > 0
        ? input.config.timeBudgetMs
        : DEFAULT_NEST_BUDGET_MS;
    const deadline = Date.now() + budget;
    let lastResult: NestingResult | null = null;

    function step() {
      try {
        // Stop before starting another generation once the budget is spent; return the
        // best layout found so far rather than nothing.
        if (Date.now() >= deadline && lastResult) {
          self.postMessage({ type: 'done', result: lastResult } satisfies WorkerResponse);
          return;
        }

        const iter = gen.next();
        if (iter.done) {
          self.postMessage({ type: 'done', result: iter.value } satisfies WorkerResponse);
        } else {
          const progress: NestingProgress = iter.value;
          lastResult = progress.result;
          self.postMessage({
            type: 'progress',
            currentSheet: progress.currentSheet,
            generation: progress.generation,
            result: progress.result,
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
