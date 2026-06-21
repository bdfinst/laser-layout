import {
  nestPartsMultiStartIterative,
  resolveTimeBudget,
  type NestingInput,
  type NestingResult,
  type NestingProgress,
} from './engine';

export type WorkerMessage = { type: 'start'; input: NestingInput };

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
