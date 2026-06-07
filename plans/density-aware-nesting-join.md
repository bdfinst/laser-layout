# Plan: Density-Aware Nesting — Join: UI + Effectiveness Capstone

**Created**: 2026-06-07
**Branch**: `feat/density-aware-nesting` (integration base, after A→B→C merge)
**Branches from**: integrated tree (Phase 0 + Slice A + Slice B + Slice C)
**Status**: approved
**Coordinator**: `plans/density-aware-nesting.md`
**Spec**: `docs/specs/density-aware-nesting.md`

## Goal

The synchronization point. With all three slices merged, make the progress UI honest (no fixed
`config.generations` denominator) and add the integration capstone that measures the **combined**
density win (A4) and guards non-regression (A5) under a pinned seed, plus a runtime budget.

## Acceptance Criteria (this unit)

- [x] A4 Gap-fill effectiveness: on a representative fixture under a pinned seed, utilization +≥0.05 absolute vs recorded baseline OR fewer sheets.
- [x] A5 Density non-regression: utilization ≥ baseline − 0.01 (baseline under the new true-area metric) and `totalPlaced` never decreases, on every fixture.
- [x] A11 Overflow + kerf preserved: existing multi-sheet overflow and kerf tests still pass.
- [x] A13 Honest progress display: `LayoutPreview.svelte`/`ExportControls.svelte` no longer divide by `config.generations`.
- [x] A14 Full gate green: `npm run lint`, `npm run check`, `npm test` all pass.

> **Determinism convention.** The integration capstone wraps its runs in the seeded LCG fixture
> (seed 42) so recorded baselines are reproducible.

## Steps

### Join: Honest progress UI + effectiveness/non-regression capstone

**Complexity**: standard
**Runs after**: A, B, C merged into one integrated tree.
**RED**:

- Integration test under the **seeded fixture** (extend `lego-shelves.integration.test.ts` or add a
  packing fixture): record the pre-change baseline (utilization + sheet count + `totalPlaced`) under
  the **new true-area metric** as documented constants with the seed noted; assert A4 (utilization
  +≥0.05 absolute vs baseline OR fewer sheets) and A5 (utilization ≥ baseline − 0.01 AND
  `totalPlaced` not decreased) on existing fixtures.
- Coarse runtime-budget assertion so the slide × up-to-`maxGenerations` worst case can't silently
  regress (integration nest completes under a generous wall-clock bound).

**GREEN**: Update `LayoutPreview.svelte:35-36` and `ExportControls.svelte:116-117` so the progress
indicator no longer divides by `config.generations` (show `Sheet S, Gen N` — current generation, no
fixed denominator, since the convergent total is unknown) (A13). Keep the existing active-state
affordance (the `class:running` styling / disabled "Nesting…" button) so the counter still reads as
live work, not a stalled total; optionally surface `bestFitness`/utilization-so-far as the real
progress signal. A13 is verified by code review (asserting transient nesting-progress text in e2e is
flaky); no RED test is required for it. If an effectiveness threshold misses, tune defaults
(`stallWindow`/`stallEpsilon`/`PENALTY_PER_UNPLACED`/`STRIP_TIEBREAK`) within spec ranges (max 2
tuning iterations), re-running A5 on all fixtures after each tune so non-regression is never traded
away.
**REFACTOR**: None expected.
**Files**: `src/lib/components/LayoutPreview.svelte`, `src/lib/components/ExportControls.svelte`,
`test/nesting/*.integration.test.ts`, `CLAUDE.md` (note the metric/termination change)
**Commit**: `feat(nesting): honest convergence progress UI + effectiveness/non-regression guards`

> **Integration note.** The UI portion (A13) functionally needs only Slice A and could land with it;
> it is grouped into the Join purely to keep the merge sequence simple.

## Build Progress

### Steps

- [x] Join: Honest progress UI + effectiveness/non-regression capstone

### Acceptance Criteria

- [x] A4 Gap-fill effectiveness (+≥0.05 utilization or fewer sheets, pinned seed)
- [x] A5 Density non-regression (≥ baseline − 0.01, totalPlaced not decreased)
- [x] A11 Overflow + kerf preserved
- [x] A13 Honest progress display (no config.generations denominator)
- [x] A14 Full gate green (lint, check, test)
