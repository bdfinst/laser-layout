import {
  nestPartsIterative,
  isBetterResult,
  sheetLowerBound,
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

    const budget =
      input.config.timeBudgetMs && input.config.timeBudgetMs > 0
        ? input.config.timeBudgetMs
        : DEFAULT_NEST_BUDGET_MS;
    const deadline = Date.now() + budget;
    // Greedy placement caps below the optimum on dense jobs, so a single GA run finds the
    // best arrangement only occasionally. Multi-start: run the whole nest repeatedly (the RNG
    // advances between starts), keep the best layout, and stop once the area lower bound is
    // reached (can't do better) or the wall-clock budget is spent.
    const floor = sheetLowerBound(input.parts, input.quantities, input.config.sheet);

    let best: NestingResult | null = null;
    let gen = nestPartsIterative(input);
    let lastProgress: NestingResult | null = null;

    /** The best layout to surface to the UI: the best completed start, else the live one. */
    function displayResult(): NestingResult | null {
      if (best && lastProgress) return isBetterResult(lastProgress, best) ? lastProgress : best;
      return best ?? lastProgress;
    }

    function reachedOptimum(): boolean {
      return best != null && best.unplaced.length === 0 && best.sheets.length <= floor;
    }

    function step() {
      try {
        // Budget spent: return the best layout found so far rather than nothing.
        if (Date.now() >= deadline) {
          const result = displayResult();
          if (result) {
            self.postMessage({ type: 'done', result } satisfies WorkerResponse);
            return;
          }
        }

        const iter = gen.next();
        if (iter.done) {
          // One start finished — fold it into the best so far.
          if (!best || isBetterResult(iter.value, best)) best = iter.value;
          lastProgress = null;
          if (reachedOptimum() || Date.now() >= deadline) {
            self.postMessage({ type: 'done', result: best! } satisfies WorkerResponse);
            return;
          }
          // Otherwise restart: a fresh GA run with the RNG advanced, keep best.
          gen = nestPartsIterative(input);
          setTimeout(step, 0);
        } else {
          const progress: NestingProgress = iter.value;
          lastProgress = progress.result;
          const shown = displayResult() ?? progress.result;
          self.postMessage({
            type: 'progress',
            currentSheet: progress.currentSheet,
            generation: progress.generation,
            result: shown,
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
