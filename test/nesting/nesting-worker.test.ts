import { describe, it, expect } from 'vitest';
import { rehydrateQuantities, runWorkerLoop, handleMessage } from '$lib/nesting/nesting-worker';
import type { WorkerResponse, WorkerMessage } from '$lib/nesting/nesting-worker';
import type { NestingInput, NestingProgress, NestingResult } from '$lib/nesting/engine';

// ── runWorkerLoop test harness ──────────────────────────────────────────────
// Injected post/now/schedule/run fakes — no real Worker, clock, or setTimeout.
// `now` is a scripted queue (last value held) so a single synchronous runWorkerLoop
// call can observe the clock crossing the deadline; `schedule` captures the
// continuation so the test drives one generation per `step()`, exactly as
// nesting-coordinator.test.ts drives its setTimer `fire`.

function makeResult(tag: number): NestingResult {
  return { sheets: [], unplaced: [], sheetWidth: 100, sheetHeight: 100, totalPlaced: tag };
}

function progress(generation: number, result: NestingResult, starts?: number): NestingProgress {
  return { currentSheet: 0, generation, result, ...(starts !== undefined ? { starts } : {}) };
}

function* genOf(progresses: NestingProgress[], final: NestingResult) {
  for (const p of progresses) yield p;
  return final;
}

// A generator that throws on its first next() — intentionally yields nothing.
// eslint-disable-next-line require-yield
function* genThrow(err: unknown): Generator<NestingProgress, NestingResult> {
  throw err;
}

function* genYieldThenThrow(
  p: NestingProgress,
  err: unknown,
): Generator<NestingProgress, NestingResult> {
  yield p;
  throw err;
}

function inputWithBudget(budgetMs: number): NestingInput {
  return {
    parts: [],
    quantities: new Map(),
    config: {
      sheet: { width: 100, height: 100 },
      kerf: 1,
      rotationSteps: 4,
      populationSize: 5,
      generations: 5,
      timeBudgetMs: budgetMs,
    },
  };
}

function makeHarness(
  run: (input: NestingInput) => Generator<NestingProgress, NestingResult>,
  nowScript: number[] = [0],
) {
  const posts: WorkerResponse[] = [];
  let scheduled: (() => void) | null = null;
  const q = [...nowScript];
  const deps = {
    post: (m: WorkerResponse) => posts.push(m),
    now: () => (q.length > 1 ? (q.shift() as number) : q[0]),
    schedule: (fn: () => void) => {
      scheduled = fn;
    },
    run,
  };
  const step = () => {
    const fn = scheduled;
    scheduled = null;
    fn?.();
  };
  return { posts, deps, step };
}

describe('runWorkerLoop', () => {
  it('reports each generation as progress, then a final done', () => {
    const r1 = makeResult(1);
    const r2 = makeResult(2);
    const final = makeResult(99);
    const h = makeHarness(() => genOf([progress(1, r1), progress(2, r2)], final), [0]);

    runWorkerLoop(inputWithBudget(60000), h.deps); // step #1 runs synchronously
    h.step(); // generation 2
    h.step(); // generator returns

    expect(h.posts.map((m) => m.type)).toEqual(['progress', 'progress', 'done']);
    expect(h.posts[0]).toMatchObject({ type: 'progress', generation: 1, result: r1 });
    expect(h.posts[1]).toMatchObject({ type: 'progress', generation: 2, result: r2 });
    expect(h.posts[2]).toMatchObject({ type: 'done', result: final });
  });

  it('posts only done for a generator that returns with no yields', () => {
    const final = makeResult(7);
    const h = makeHarness(() => genOf([], final), [0]);

    runWorkerLoop(inputWithBudget(60000), h.deps);

    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toMatchObject({ type: 'done', result: final, starts: 0 });
  });

  it('propagates the latest start count to progress and done messages', () => {
    const h = makeHarness(
      () => genOf([progress(1, makeResult(1), 3), progress(2, makeResult(2), 7)], makeResult(9)),
      [0],
    );

    runWorkerLoop(inputWithBudget(60000), h.deps);
    h.step();
    h.step();

    expect(h.posts[0]).toMatchObject({ type: 'progress', starts: 3 });
    expect(h.posts[1]).toMatchObject({ type: 'progress', starts: 7 });
    expect(h.posts[2]).toMatchObject({ type: 'done', starts: 7 });
  });

  it('cuts off at the deadline with the best-so-far result and does not advance again', () => {
    const r1 = makeResult(1);
    // now: construction→0 (deadline 0+1000), step#1→0 (<deadline, emits r1), step#2→BIG (≥deadline)
    const h = makeHarness(
      () => genOf([progress(1, r1, 2), progress(2, makeResult(2))], makeResult(9)),
      [0, 0, 1_000_000],
    );

    runWorkerLoop(inputWithBudget(1000), h.deps);
    h.step(); // budget reached → done(best-so-far), generator not advanced to gen 2

    expect(h.posts.map((m) => m.type)).toEqual(['progress', 'done']);
    expect(h.posts[1]).toMatchObject({ type: 'done', result: r1 });
    expect(h.posts.filter((m) => m.type === 'progress')).toHaveLength(1);
  });

  it('does not post done before any result exists, then posts it once one arrives', () => {
    const r1 = makeResult(1);
    // now: construction→0 (deadline 0+1000), step#1→BIG (≥deadline but no result yet → must advance)
    const h = makeHarness(() => genOf([progress(1, r1, 0)], makeResult(9)), [0, 1_000_000]);

    runWorkerLoop(inputWithBudget(1000), h.deps);
    // step #1 saw the deadline already passed but had no result → it advanced and emitted r1, no done.
    expect(h.posts.map((m) => m.type)).toEqual(['progress']);

    h.step(); // now a result exists and we are past the deadline → done on this step
    expect(h.posts.map((m) => m.type)).toEqual(['progress', 'done']);
    expect(h.posts[1]).toMatchObject({ type: 'done', result: r1 });
  });

  it('reports a generator Error as exactly one error message with its text', () => {
    const h = makeHarness(() => genThrow(new Error('gen boom')), [0]);

    runWorkerLoop(inputWithBudget(60000), h.deps);

    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toEqual({ type: 'error', message: 'gen boom' });
  });

  it('reports a mid-stream throw as an error after the prior progress', () => {
    const r1 = makeResult(1);
    const h = makeHarness(() => genYieldThenThrow(progress(1, r1), new Error('mid boom')), [0]);

    runWorkerLoop(inputWithBudget(60000), h.deps); // step #1 emits progress
    h.step(); // step #2 advances → generator throws → inner catch posts error, no reschedule

    expect(h.posts.map((m) => m.type)).toEqual(['progress', 'error']);
    expect(h.posts[1]).toEqual({ type: 'error', message: 'mid boom' });
  });

  it('stringifies a non-Error throw in the error message', () => {
    const h = makeHarness(() => genThrow('plain string failure'), [0]);

    runWorkerLoop(inputWithBudget(60000), h.deps);

    expect(h.posts).toEqual([{ type: 'error', message: 'plain string failure' }]);
  });

  it('reports a setup failure (generator factory throws) as an error', () => {
    const h = makeHarness(() => {
      throw new Error('setup boom');
    }, [0]);

    runWorkerLoop(inputWithBudget(60000), h.deps);

    expect(h.posts).toEqual([{ type: 'error', message: 'setup boom' }]);
  });
});

describe('handleMessage', () => {
  it('posts nothing for a non-start message', () => {
    const posts: WorkerResponse[] = [];
    const deps = { post: (m: WorkerResponse) => posts.push(m), now: () => 0, schedule: () => {} };

    handleMessage({ type: 'stop' } as unknown as WorkerMessage, deps);

    expect(posts).toHaveLength(0);
  });

  it('drives the loop for a start message', () => {
    const posts: WorkerResponse[] = [];
    const final = makeResult(5);
    const deps = {
      post: (m: WorkerResponse) => posts.push(m),
      now: () => 0,
      schedule: () => {},
      run: () => genOf([], final),
    };

    handleMessage({ type: 'start', input: inputWithBudget(60000) }, deps);

    expect(posts).toEqual([{ type: 'done', result: final, starts: 0 }]);
  });
});

describe('rehydrateQuantities', () => {
  it('returns a Map input as an equal copy, not the same reference', () => {
    const input = new Map<string, number>([
      ['a', 2],
      ['b', 5],
    ]);
    const result = rehydrateQuantities(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });

  it('turns an array of [id, count] pairs into a map', () => {
    const result = rehydrateQuantities([
      ['a', 2],
      ['b', 5],
    ]);
    expect(result).toEqual(
      new Map([
        ['a', 2],
        ['b', 5],
      ]),
    );
  });

  it('turns a plain object into a map', () => {
    const result = rehydrateQuantities({ a: 2, b: 5 });
    expect(result).toEqual(
      new Map([
        ['a', 2],
        ['b', 5],
      ]),
    );
  });

  it('coerces numeric-string object values to numbers', () => {
    const result = rehydrateQuantities({ a: '2', b: '5' });
    expect(result.get('a')).toBe(2);
    expect(result.get('b')).toBe(5);
  });

  it('coerces a non-numeric object value verbatim to NaN (pinned, not fixed)', () => {
    const result = rehydrateQuantities({ a: 'abc' });
    expect(result.get('a')).toBeNaN();
  });

  it('yields an empty map for empty Map, array, or object inputs', () => {
    expect(rehydrateQuantities(new Map())).toEqual(new Map());
    expect(rehydrateQuantities([])).toEqual(new Map());
    expect(rehydrateQuantities({})).toEqual(new Map());
  });
});
