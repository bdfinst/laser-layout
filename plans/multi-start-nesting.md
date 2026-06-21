# Plan: Multi-start nesting for reliable material utilization (#issue-utilization)

**Created**: 2026-06-21
**Branch**: claude/happy-mayer-fjta2s
**Status**: approved

## Goal

Make the nester reliably fit dense jobs (KPI: `test-fixtures/lego-shelves.lbrn2` on one
508×762 mm sheet) without regressing other fixtures or the fast path. Backed by an
ablation: every greedy placer caps at 8–10/12 on lego (bbox packing is geometrically
impossible — bbox area 389k > 387k sheet), so the bottleneck is **global arrangement
search**. Multi-start (several independent GA runs, keep the best, early-stop at the area
lower bound) raises the placer's ~40%/run one-sheet rate to **5/5** at ~60–70s.

## Approach (validated empirically)

- **Placer improvement (density/NFP path only):** orientation rescue (try +90° only when a
  part's gene rotation can't be placed) + a fine-grid fallback. Lifts deterministic
  placement 9→10/12; fast path and non-opt-in callers byte-for-byte unchanged.
- **Multi-start:** repeat the whole nest with fresh RNG, keep the best result (fewest
  unplaced, then fewest sheets, then densest), bounded by `timeBudgetMs`, early-stopping
  when the best reaches the area lower bound. The worker reports best-so-far progress.

## Acceptance Criteria

- [ ] `lego-shelves[nfp=1]` 508×762 reliably nests onto **1 sheet** under multi-start within the time budget.
- [ ] No regression: Hot Air Balloon sheet counts and the `nfp=0` fast path unchanged.
- [ ] Multi-start keeps the best across starts (never worse than a single start).
- [ ] Early-stop at the area lower bound so easy jobs don't burn the whole budget.
- [ ] `npm run lint`, `npm run check`, `npm test` green.

## Slices

### Slice A: Placer improvement (orientation rescue + fine-grid fallback)

**Files:** `src/lib/nesting/placement.ts`, `test/nesting/placement.test.ts`

- Orientation rescue: density path tries gene rotation, then +90° only if it fails to place.
- Fine-grid fallback step on the density path.
- Test: a part too wide at rotation 0 but fitting rotated is placed at +90°.

### Slice B: Multi-start engine helper

**Files:** `src/lib/nesting/engine.ts`, `test/nesting/engine.test.ts`

- `isBetterResult(a,b)`, `sheetLowerBound(parts,quantities,sheet)`, `nestPartsMultiStart(input, opts?)` (sync; loops `nestParts`, keeps best, bounded by `opts.timeBudgetMs`/`opts.maxStarts` + lower-bound early stop; injectable `now` for deterministic tests).
- Tests: keeps the best of several starts; stops at lower bound; respects maxStarts.

### Slice C: Worker uses multi-start with progress

**Files:** `src/lib/nesting/nesting-worker.ts`

- Loop starts within the deadline; track best; report best-so-far progress; done when budget spent or lower bound reached.

### Slice D: Bench reflects the strategy

**Files:** `bench/nesting-compaction.bench.ts`

- Add a `lego-shelves[multistart]` row (existing single-start rows stay for comparability).

## Build Progress

- [ ] Slice A: placer improvement
- [ ] Slice B: multi-start engine helper
- [ ] Slice C: worker multi-start
- [ ] Slice D: bench row
