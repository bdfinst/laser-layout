import { describe, it, expect } from 'vitest';
import {
  mergeBest,
  desiredWorkerCount,
  runParallelNest,
  type WorkerLike,
  type CoordinatorHandlers,
} from '$lib/nesting/nesting-coordinator';
import type { NestingResult } from '$lib/nesting/engine';
import type { WorkerResponse } from '$lib/nesting/nesting-worker';

/**
 * Build a NestingResult skeleton with a chosen unplaced count and sheet count — enough to drive
 * `isBetterResult` (fewer unplaced, then fewer sheets, then less used area).
 */
function result(unplaced: number, sheets: number, stripHeight = 10): NestingResult {
  return {
    sheets: Array.from({ length: sheets }, (_, i) => ({
      sheetIndex: i,
      placed: [],
      stripHeight,
      utilization: 0,
    })),
    unplaced: Array.from({ length: unplaced }, (_, i) => ({
      id: `u${i}`,
      name: `u${i}`,
      polygons: [],
      sourceIndex: 0,
    })),
    sheetWidth: 100,
    sheetHeight: 100,
    totalPlaced: 0,
  };
}

/** A controllable fake worker: capture handlers, then drive messages from the test. */
function fakeWorker(): WorkerLike & {
  emit: (msg: WorkerResponse) => void;
  emitError: (e: unknown) => void;
  posted: unknown[];
  terminated: boolean;
} {
  const w = {
    onmessage: null as WorkerLike['onmessage'],
    onerror: null as WorkerLike['onerror'],
    posted: [] as unknown[],
    terminated: false,
    postMessage(message: unknown) {
      this.posted.push(message);
    },
    terminate() {
      this.terminated = true;
    },
    emit(msg: WorkerResponse) {
      this.onmessage?.({ data: msg });
    },
    emitError(e: unknown) {
      this.onerror?.(e);
    },
  };
  return w;
}

const noopHandlers: CoordinatorHandlers = {
  onProgress: () => {},
  onDone: () => {},
  onError: () => {},
};

describe('mergeBest', () => {
  it('keeps the existing best when the new result is not strictly better', () => {
    const best = result(0, 1);
    expect(mergeBest(best, result(0, 2))).toBe(best); // more sheets ⇒ worse
  });

  it('adopts a strictly better result (fewer unplaced)', () => {
    const worse = result(3, 1);
    const better = result(1, 1);
    expect(mergeBest(worse, better)).toBe(better);
  });

  it('takes the first result when there is no prior best', () => {
    const r = result(2, 2);
    expect(mergeBest(null, r)).toBe(r);
  });
});

describe('desiredWorkerCount', () => {
  it('uses one worker per core', () => {
    expect(desiredWorkerCount(4)).toBe(4);
  });

  it('clamps to at least one (degrades to serial)', () => {
    expect(desiredWorkerCount(0)).toBe(1);
    expect(desiredWorkerCount(undefined)).toBe(1);
  });

  it('caps oversubscription', () => {
    expect(desiredWorkerCount(64, 8)).toBe(8);
  });
});

describe('runParallelNest', () => {
  it('spawns one worker per requested start and posts the input to each', () => {
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const factory = () => {
      const w = fakeWorker();
      workers.push(w);
      return w;
    };
    runParallelNest({ tag: 'in' }, 3, factory, noopHandlers);

    expect(workers).toHaveLength(3);
    for (const w of workers) {
      expect(w.posted).toEqual([{ type: 'start', input: { tag: 'in' } }]);
    }
  });

  it('reports the global best on done and sums starts across workers', () => {
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const factory = () => {
      const w = fakeWorker();
      workers.push(w);
      return w;
    };

    let done: { result: NestingResult; totalStarts: number } | null = null;
    runParallelNest({}, 2, factory, {
      ...noopHandlers,
      onDone: (result, totalStarts) => {
        done = { result, totalStarts };
      },
    });

    // Worker 0 finds a 2-sheet layout over 5 starts; worker 1 finds a better 1-sheet over 7.
    workers[0].emit({ type: 'done', result: result(0, 2), starts: 5 });
    expect(done).toBeNull(); // not all finished yet
    workers[1].emit({ type: 'done', result: result(0, 1), starts: 7 });

    expect(done).not.toBeNull();
    expect(done!.result.sheets).toHaveLength(1); // the better of the two
    expect(done!.totalStarts).toBe(12); // strictly more than either worker alone
  });

  it('never returns worse than the best single worker, regardless of arrival order', () => {
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const factory = () => {
      const w = fakeWorker();
      workers.push(w);
      return w;
    };
    let final: NestingResult | null = null;
    runParallelNest({}, 2, factory, { ...noopHandlers, onDone: (r) => (final = r) });

    // Better result arrives first, worse second — merge must still keep the better one.
    workers[0].emit({ type: 'done', result: result(0, 1), starts: 4 });
    workers[1].emit({ type: 'done', result: result(2, 1), starts: 4 });

    expect(final!.unplaced).toHaveLength(0);
  });

  it('forwards best-so-far progress', () => {
    const w = fakeWorker();
    const progresses: NestingResult[] = [];
    runParallelNest({}, 1, () => w, {
      ...noopHandlers,
      onProgress: (_s, _g, r) => progresses.push(r),
    });

    w.emit({ type: 'progress', currentSheet: 0, generation: 1, result: result(1, 1), starts: 0 });
    expect(progresses).toHaveLength(1);
    expect(progresses[0].unplaced).toHaveLength(1);
  });

  it('still succeeds when one worker errors but another produces a result', () => {
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const factory = () => {
      const w = fakeWorker();
      workers.push(w);
      return w;
    };
    let done: NestingResult | null = null;
    let errored = false;
    runParallelNest({}, 2, factory, {
      ...noopHandlers,
      onDone: (r) => (done = r),
      onError: () => (errored = true),
    });

    workers[0].emit({ type: 'error', message: 'boom' });
    workers[1].emit({ type: 'done', result: result(0, 1), starts: 3 });

    expect(errored).toBe(false);
    expect(done).not.toBeNull();
  });

  it('reports an error only when every worker fails without a result', () => {
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const factory = () => {
      const w = fakeWorker();
      workers.push(w);
      return w;
    };
    let errorMsg: string | null = null;
    let done = false;
    runParallelNest({}, 2, factory, {
      ...noopHandlers,
      onDone: () => (done = true),
      onError: (m) => (errorMsg = m),
    });

    workers[0].emit({ type: 'error', message: 'first' });
    workers[1].emit({ type: 'error', message: 'second' });

    expect(done).toBe(false);
    expect(errorMsg).toBe('second');
  });

  it('terminate() stops every worker and silences further messages', () => {
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const factory = () => {
      const w = fakeWorker();
      workers.push(w);
      return w;
    };
    let doneCalls = 0;
    const handle = runParallelNest({}, 2, factory, {
      ...noopHandlers,
      onDone: () => doneCalls++,
    });

    handle.terminate();
    expect(workers.every((w) => w.terminated)).toBe(true);

    // Late messages after terminate must be ignored.
    workers[0].emit({ type: 'done', result: result(0, 1), starts: 1 });
    workers[1].emit({ type: 'done', result: result(0, 1), starts: 1 });
    expect(doneCalls).toBe(0);
  });
});
