# Plan: Density-Aware Nesting with Convergence-Based GA Termination — Coordinator

**Created**: 2026-06-07
**Branch**: `feat/density-aware-nesting` (integration base)
**Status**: approved
**Spec**: `docs/specs/density-aware-nesting.md`
**Type**: coordinator — owns goal, all acceptance criteria, the shared behavior contract, and the
merge gate. Each unit is its own plan file with its own Build Progress (see Slices index below).

## Goal

Make the nesting optimizer pack denser and stop smarter. Replace the strip-height-only fitness
with a density objective (open-area ratio over the used region, using true polygon area, with the
heavy unplaced penalty retained and strip height demoted to a tiebreaker); add interior-gap
placement (anchors + bottom-left slide compaction); and replace the fixed GA generation count with
convergence-based termination (stall window) bounded by a safety cap. The `optimizeIterative`
generator contract, multi-sheet overflow, kerf semantics, and per-generation progress reporting are
all preserved. Delivered as a **diamond**: a sequential behavior-preserving Phase 0 foundation
(extract `stats.ts` + scaffold config fields), then three independent parallel slices (convergence,
density fitness, gap-filling) developed concurrently, then a sequential Join (honest progress UI +
effectiveness/non-regression capstone) — the capstone being the one unavoidable synchronization
point where the combined density win is measured.

## Acceptance Criteria

- [ ] A1 Density objective: pure `openAreaStats`/`fitnessFromStats` rank denser layouts better, true polygon area, finite worst-case fitness on empty placement (no NaN/∞).
- [ ] A2 Feasibility dominates: any all-placed layout beats any layout with ≥1 unplaced part.
- [ ] A3 Gap-fill correctness: kerf=0 → no polygon overlap (bbox overlap allowed); kerf>0 → bbox separation ≥ kerf; all parts inside the sheet.
- [ ] A4 Gap-fill effectiveness: on a representative fixture under a pinned seed, utilization +≥0.05 absolute vs recorded baseline OR fewer sheets.
- [ ] A5 Density non-regression: utilization ≥ baseline − 0.01 (baseline under the new true-area metric) and `totalPlaced` never decreases, on every fixture.
- [ ] A6 Convergence stops early: `hasStalled` returns true on a stalling history; generator terminates at `< maxGenerations`, returns best-so-far.
- [ ] A7 Safety cap: with convergence disarmed (`stallWindow ≥ maxGenerations`), runs exactly `maxGenerations` generations.
- [ ] A8 Window guard: `hasStalled` returns false with fewer than `stallWindow + 1` recorded generations (pure unit test).
- [ ] A9 Progress contract: one `OptimizeProgress` per generation, each with generation/bestFitness/bestPlacement (seeded fixture).
- [ ] A10 Config threading: new `NestingConfig` fields default, pass-through, and partial-override correctly via `makeOptimizerConfig`; degenerate configs still terminate.
- [ ] A11 Overflow + kerf preserved: existing multi-sheet overflow and kerf tests still pass.
- [ ] A12 Single source of truth: reported `SheetResult.utilization` == `1 − openAreaRatio` from the same `openAreaStats` the GA minimizes.
- [ ] A13 Honest progress display: `LayoutPreview.svelte`/`ExportControls.svelte` no longer divide by `config.generations`.
- [ ] A14 Full gate green: `npm run lint`, `npm run check`, `npm test` all pass.

## User-Facing Behavior

```gherkin
Feature: Density-aware nesting with convergence-based GA termination

  Background:
    Given a material sheet and a set of parts that fit on it
    And the nesting config provides populationSize, rotationSteps, kerf, generations,
      and the new fields stallWindow, stallEpsilon, and maxGenerations

  # --- Density-aware fitness ---

  Scenario: Denser packing is preferred over a taller but gappier layout
    Given two candidate layouts of the same parts on one sheet
    And layout A has a lower open-area ratio than layout B
    When the optimizer evaluates both
    Then layout A has the better (lower) fitness
    And open-area ratio is computed as (usedArea - partsArea) / usedArea
    And partsArea is the true polygon area: area(outer) minus area(each cutout)
    And usedArea is stripHeight * sheet.width

  Scenario: Feasibility dominates density
    Given layout A places all parts with a high open-area ratio
    And layout B leaves one part unplaced with a low open-area ratio
    When the optimizer evaluates both
    Then layout A has the better (lower) fitness
    Because the unplaced penalty outweighs any open-area-ratio difference

  Scenario: Strip height breaks ties between equally dense layouts
    Given two layouts with identical open-area ratio and identical placed counts
    And layout A has a smaller strip height than layout B
    When the optimizer evaluates both
    Then layout A has the better (lower) fitness

  Scenario: Empty placement yields a finite worst-case fitness
    Given an individual whose ordering places no parts on the sheet
    When the optimizer evaluates it
    Then its fitness equals parts.length * PENALTY_PER_UNPLACED + openAreaRatio default (1)
    And the fitness is a finite number (no division-by-zero or NaN)

  # --- Gap-filling placement ---

  Scenario: A small part is tucked into an interior gap
    Given placed parts leave an open interior gap large enough for the next part
    And a bounding-box corner is also available that would increase strip height
    When the next part is placed
    Then it is placed in the interior gap
    And it does not increase the strip height
    And it does not overlap any placed part (respecting kerf)

  Scenario: Gap-filling never produces an overlap
    Given any set of parts placed by bottomLeftFill
    When placement completes
    Then for kerf = 0, no two placed polygons overlap (overlapping bboxes are allowed)
    And for kerf > 0, bounding-box separation is >= kerf (inclusive of touching at exactly kerf)
    And every placed part lies fully within the sheet

  Scenario: Existing hole/NFP placement still wins when applicable
    Given a placed part has an interior hole large enough for the next part
    When the next part is placed
    Then it is placed inside the hole (hole placement remains highest priority)

  # --- Convergence-based termination ---

  Scenario: The GA stops early when fitness stalls
    Given the best fitness does not improve by at least stallEpsilon (relative)
      over stallWindow consecutive generations
    When the optimizer runs
    Then it stops before reaching maxGenerations
    And it returns the best placement found so far

  Scenario: The GA never exceeds the safety cap
    Given convergence is disarmed (stallWindow >= maxGenerations)
    When the optimizer runs
    Then it stops at exactly maxGenerations generations
    And it returns the best placement found

  Scenario: Convergence cannot trigger before a full window has elapsed
    Given a fitness history with fewer than stallWindow recorded generations
    When the stall check (hasStalled) is evaluated
    Then it returns false (the run does not stop)

  Scenario: Stall check is safe when best fitness is near zero
    Given a fitness history whose windowed-back value is zero or near zero
    When the stall check (hasStalled) is evaluated
    Then it returns a defined boolean with no division-by-zero, NaN, or Infinity

  Scenario: Degenerate convergence config still terminates
    Given stallWindow is 0, 1, or greater than maxGenerations, or stallEpsilon <= 0
    When the optimizer runs on a stalling case
    Then it always terminates within maxGenerations generations
    And it yields at least one progress value

  Scenario: Progress is still yielded once per generation
    Given the optimizer runs for K generations (early-stopped or capped)
    When it is driven via optimizeIterative
    Then it yields exactly K OptimizeProgress values, one per generation
    And each carries generation, bestFitness, and bestPlacement

  # --- Non-regression / edges ---

  Scenario: No parts to nest
    Given an empty parts list
    When the optimizer runs
    Then it yields no progress and returns an empty placement

  Scenario: A part larger than the sheet is skipped, not crashed
    Given a part whose bounding box exceeds the sheet in either dimension
    When placement runs
    Then that part is left unplaced and the others place normally

  Scenario: Parts that do not fit overflow to the next sheet
    Given more parts than fit on one sheet
    When nestPartsIterative runs
    Then the surplus parts are nested onto a subsequent sheet
    And no part is dropped silently

  Scenario: Kerf spacing is preserved
    Given kerf > 0
    When parts are placed
    Then the kerf>0 bounding-box overlap approximation in checkOverlap still applies
    And the spacing between placed parts is at least kerf

  Scenario: No overlap at kerf zero
    Given kerf = 0
    When parts are placed
    Then no two placed polygons overlap (exact polygon test)
    And overlapping bounding boxes are permitted when the polygons themselves do not overlap

  Scenario: Gap-filling never places fewer parts than before
    Given a fixture nested before and after gap-filling under the same RNG seed
    When both runs complete
    Then the after-run places at least as many parts as the before-run
    And uses no more sheets than the before-run

  Scenario: Partial config override threads correctly
    Given a NestingConfig that sets stallWindow but omits stallEpsilon and maxGenerations
    When makeOptimizerConfig runs
    Then stallWindow is the provided value
    And stallEpsilon and maxGenerations take their defaults

  Scenario: Progress display reflects an unknown total
    Given the GA terminates on convergence at an a-priori unknown generation
    When nesting progress is shown to the user
    Then the indicator shows the current generation without a fixed denominator
    And it does not claim progress toward a total the run will not reach
```

## Slices (the diamond)

Each unit is a standalone plan file with its own RED/GREEN/REFACTOR and Build Progress. Run order:
Phase 0 (sequential) → Slices A/B/C (parallel, worktrees) → merge A→B→C → Join (sequential).

| Unit    | Plan file                                      | Branch / worktree                         |
| ------- | ---------------------------------------------- | ----------------------------------------- |
| Phase 0 | `density-aware-nesting-phase0-foundation.md`   | `feat/density-nesting-phase0` → base      |
| Slice A | `density-aware-nesting-slice-a-convergence.md` | `feat/density-nesting-slice-a` (worktree) |
| Slice B | `density-aware-nesting-slice-b-fitness.md`     | `feat/density-nesting-slice-b` (worktree) |
| Slice C | `density-aware-nesting-slice-c-gapfill.md`     | `feat/density-nesting-slice-c` (worktree) |
| Join    | `density-aware-nesting-join.md`                | `feat/density-aware-nesting` (base)       |

> **Determinism convention (all units).** GA-driven tests reuse the existing seeded-`Math.random`
> LCG fixture already in `test/nesting/optimizer.test.ts:23-34` and `engine.test.ts:31-39` (seed 42,
> `seed = seed*16807 % 2147483647`). Convergence _logic_ is tested through the pure `hasStalled`
> helper with hand-built fitness arrays — no GA, no RNG. The Join capstone wraps its runs in the same
> fixture so baselines are reproducible. The units under test for fitness/density are the **exported
> pure** helpers `openAreaStats` / `fitnessFromStats` / `hasStalled` — never a private symbol reached
> through the GA.

### Parallelization (diamond)

```
Phase 0 — Foundation (sequential, lands on main first)
        │
   ┌────┼────┐
 Slice A  Slice B  Slice C        ← developed concurrently (separate branches/worktrees off Phase 0)
   └────┼────┘
        │
   Join — UI + effectiveness/non-regression capstone (sequential, after A+B+C merge)
```

Phase 0 is behavior-preserving (mechanical extraction + additive types), so it merges with the
suite green and gives the three slices a stable base. After Phase 0 the slices touch near-disjoint
surfaces — the only shared file is `optimizer.ts`, edited by A (the GA loop) and B (`evaluate`),
which are **different functions** and merge cleanly. Each slice is independently green and
committable. The Join's effectiveness capstone (A4/A5) is the unavoidable synchronization point — it
measures the integrated system and can only run after all three merge.

| Unit    | Depends on | Shares files with                   | Primary files                                                                   |
| ------- | ---------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| Phase 0 | —          | (lands first)                       | `types.ts`, `stats.ts` (new), `optimizer.ts`/`placement.ts`/`engine.ts` imports |
| Slice A | Phase 0    | B (different fns in `optimizer.ts`) | `optimizer.ts`, `engine.ts`                                                     |
| Slice B | Phase 0    | A (different fns in `optimizer.ts`) | `optimizer.ts`, `stats.ts`                                                      |
| Slice C | Phase 0    | —                                   | `placement.ts`                                                                  |
| Join    | A, B, C    | —                                   | Svelte UI, integration tests, `CLAUDE.md`                                       |

## Complexity Classification

| Unit    | Rating   | Rationale                                                                      | Detail                     |
| ------- | -------- | ------------------------------------------------------------------------------ | -------------------------- |
| Phase 0 | standard | Behavior-preserving extraction + additive types; no logic change.              | `…-phase0-foundation.md`   |
| Slice A | complex  | Alters generator control flow + `OptimizerConfig` shape; cross-cutting.        | `…-slice-a-convergence.md` |
| Slice B | complex  | Changes the core optimization objective; affects all nesting output.           | `…-slice-b-fitness.md`     |
| Slice C | complex  | Geometry/placement algorithm change with overlap-safety correctness risk.      | `…-slice-c-gapfill.md`     |
| Join    | standard | Small UI edit + integration tests; possible default tuning inside spec ranges. | `…-join.md`                |

> **Integration note.** The UI portion (A13) functionally needs only Slice A and could land with it;
> it is grouped into the Join purely to keep the merge sequence simple.

## Pre-PR Quality Gate

- [ ] All tests pass (`npm test`)
- [ ] Type check passes (`npm run check`)
- [ ] Linter passes (`npm run lint`)
- [ ] `/code-review` passes
- [ ] Documentation updated (CLAUDE.md nesting-pipeline notes if config fields/behavior changed)

## Risks & Open Questions

- **R1 — Single-sheet equivalence.** On a fixed-width sheet with a fixed placed set, minimizing
  strip height already minimizes open area; the density win comes from _placing more parts per
  sheet_ (gap-filling + the retained unplaced penalty). So Slices A/B deliver no measurable A4 win
  alone. Mitigation: A4 is measured in the Join after all three slices merge; A/B/C are each
  validated by their own unit criteria, not A4. This is the inherent join cost of the diamond.
- **R2 — A4 threshold realism.** +0.05 absolute utilization may be too strict or too loose for the
  chosen fixture. Mitigation: the Join records the actual baseline first; if the fixture can't show
  ≥0.05, switch the assertion to the "fewer sheets" arm or pick a fixture that exercises gaps.
- **R3 — Slide compaction cost (decided).** `bottomLeftFill` runs once per individual per
  generation, and the cap raises the worst case from 50 to `maxGenerations` (≥200), so per-placement
  cost compounds. Decision: the slide uses a **coarse step with bounded iterations** (Slice C GREEN),
  and the Join adds a runtime-budget assertion rather than only "watching" runtime.
- **R4 — openAreaRatio clamping.** True `partsArea` vs bbox-derived `usedArea` can make the raw
  ratio slightly negative on tight packs; clamp to `[0,1]`. Covered by Slice B `stats.test.ts`.
- **R5 — Displayed-utilization semantics change (resolved in scope).** Switching to true area
  lowers the reported "Use: X%" for holed parts. Intended; A5 baselines are recorded under the new
  metric, and the change is noted in `CLAUDE.md` (Join).
- **R6 — Parallel-merge integration (new, from the diamond).** Slices A and B both edit
  `optimizer.ts` (loop vs `evaluate` — different functions) and B's `fitnessFromStats` consumes
  `stats.ts` while A leaves it alone, so merge conflicts are mechanical and region-disjoint.
  Mitigation: Phase 0 lands the shared scaffolding first; integrate A → B → C in that order and run
  the full suite after each merge before the Join. If using worktrees, each slice gets its own.
- **Q1 — `NestingConfig.generations` semantics (resolved).** Retained as the cap baseline; the UI
  no longer renders it as a literal denominator — `LayoutPreview.svelte`/`ExportControls.svelte` are
  updated in the Join (A13) to show `Gen N` without a total.

## Plan Review Summary

Four plan-review personas ran in parallel (sonnet). Iteration 1: all four `needs-revision`
(2 with blockers). The plan and spec were revised; iteration 2: **design, UX, strategic — approve**;
acceptance flagged one blocker + warnings, all fixed directly in a final pass.

**Blockers raised and resolved**

- _Acceptance_ — "fitness keeps improving every generation" (A7) is unrealizable under elitism →
  safety cap is now tested by **disarming convergence** (`stallWindow ≥ maxGenerations`).
- _Acceptance_ — fitness `evaluate` was private/untestable → A1–A3 now test **exported pure**
  `openAreaStats`/`fitnessFromStats`.
- _Acceptance_ — stall ratio divided by a possibly-zero fitness → **`denom = max(|prev|, 1e-9)`**
  guard + near-zero test.
- _Acceptance_ — convergence/fitness tests ignored determinism → tests now use the **existing seeded
  LCG fixture** (seed 42); convergence logic tested via the **pure `hasStalled`** helper (no GA).
- _Acceptance (iter 2)_ — "Gap-filling never produces an overlap" asserted bbox non-overlap,
  contradicting the kerf=0 behavior → rewritten kerf-aware (polygon test at kerf=0, bbox separation
  ≥ kerf at kerf>0).
- _Design_ — density metric computed in two places → new **`stats.ts` single source of truth**
  (`openAreaStats`); reported `utilization == 1 − openAreaRatio` (A12); dedup is now mandatory.

**Warnings absorbed**

- True-area `partsArea` must **subtract** cutouts (polygonArea is always positive) — convention
  pinned + a guard test added (A1).
- Step 2 re-baselines existing utilization assertions **in-step** (suite stays green).
- Import direction pinned: everything imports `stats.ts` directly; no re-exports.
- Slide cost decided (coarse step, bounded iters) + runtime-budget assertion (R3); slide reuses
  `hasCollision` for the sheet bound.
- UI progress badge drops the `config.generations` denominator (A13) and keeps the existing
  running-state affordance; A13 verified by code review.
- Displayed utilization drops for holed parts — intended, documented (R5 + CLAUDE.md).

**Residual (non-blocking) observations**

- `placement.ts` may exceed ~400 lines after Step 3; Step 3 REFACTOR extracts the slide helper and
  may split a `collision`/`candidates` module — accept or split as a conscious call during REFACTOR.

## Build Progress

> Coordinator-level rollup. Each unit's own RED/GREEN/REFACTOR progress lives in its slice file's
> Build Progress; this section tracks unit completion, the merge sequence, and the aggregated
> acceptance criteria.

### Units (each implemented + green in its own branch/worktree)

- [x] Phase 0: Foundation — `…-phase0-foundation.md`
- [ ] Slice A: Convergence — `…-slice-a-convergence.md`
- [ ] Slice B: Density fitness — `…-slice-b-fitness.md`
- [ ] Slice C: Gap-filling — `…-slice-c-gapfill.md`
- [ ] Join: UI + capstone — `…-join.md`

### Merge sequence (full suite green after each)

- [x] Phase 0 → integration base `feat/density-aware-nesting`
- [ ] Merge Slice A → base
- [ ] Merge Slice B → base (resolve mechanical `optimizer.ts` overlap with A)
- [ ] Merge Slice C → base
- [ ] Join lands on base
- [ ] `/code-review` + Pre-PR gate

### Acceptance Criteria

- [ ] A1 Density objective (pure helpers, true area, finite worst-case fitness)
- [ ] A2 Feasibility dominates density
- [ ] A3 Gap-fill correctness (kerf=0 polygon, kerf>0 bbox separation, inside sheet)
- [ ] A4 Gap-fill effectiveness (+≥0.05 utilization or fewer sheets, pinned seed)
- [ ] A5 Density non-regression (≥ baseline − 0.01, totalPlaced not decreased)
- [ ] A6 Convergence stops early (hasStalled + generator)
- [ ] A7 Safety cap (convergence disarmed → exactly maxGenerations)
- [ ] A8 Window guard (pure hasStalled)
- [ ] A9 Per-generation progress contract
- [ ] A10 Config threading (defaults, pass-through, partial, degenerate)
- [ ] A11 Overflow + kerf preserved
- [ ] A12 Single source of truth (utilization == 1 − openAreaRatio)
- [ ] A13 Honest progress display (no config.generations denominator)
- [ ] A14 Full gate green (lint, check, test)
