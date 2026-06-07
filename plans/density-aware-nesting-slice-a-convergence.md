# Plan: Density-Aware Nesting — Slice A: Convergence Termination

**Created**: 2026-06-07
**Branch**: `feat/density-nesting-slice-a` (worktree)
**Branches from**: Phase 0 commit (`refactor(nesting): extract stats module …`)
**Status**: approved
**Coordinator**: `plans/density-aware-nesting.md`
**Spec**: `docs/specs/density-aware-nesting.md`
**Shares files with**: Slice B — both edit `optimizer.ts` but different functions (loop vs `evaluate`); merge is mechanical.

## Goal

Replace the fixed GA generation count with convergence-based termination: stop when best fitness
stalls (no meaningful relative improvement over a configurable window), bounded by a safety cap.
Fitness stays strip-height on this branch (Slice B owns the objective) so the slice is green alone.

## Acceptance Criteria (this unit)

- [ ] A6 Convergence stops early: `hasStalled` returns true on a stalling history; generator terminates at `< maxGenerations`, returns best-so-far.
- [ ] A7 Safety cap: with convergence disarmed (`stallWindow ≥ maxGenerations`), runs exactly `maxGenerations` generations.
- [ ] A8 Window guard: `hasStalled` returns false with fewer than `stallWindow + 1` recorded generations (pure unit test).
- [ ] A9 Progress contract: one `OptimizeProgress` per generation, each with generation/bestFitness/bestPlacement (seeded fixture).
- [ ] A10 Config threading: new fields default, pass-through, and partial-override correctly via `makeOptimizerConfig`; degenerate configs still terminate.

> **Determinism convention.** GA-driven tests reuse the existing seeded-`Math.random` LCG fixture in
> `test/nesting/optimizer.test.ts:23-34` and `engine.test.ts:31-39` (seed 42). Convergence _logic_ is
> tested through the pure exported `hasStalled` helper with hand-built fitness arrays — no GA, no RNG.

## Steps

### Slice A: Convergence-based GA termination + pure `hasStalled`

**Complexity**: complex
**RED**:

- Pure `hasStalled(history, window, epsilon)` in `test/nesting/optimizer.test.ts` (deterministic,
  no GA): (a) `false` when `history.length < window + 1` (window guard, A8); (b) `true` when
  relative improvement over the window `< epsilon`; (c) `false` when improvement `≥ epsilon`;
  (d) near-zero windowed-back fitness → defined boolean, no NaN/∞/divide-by-zero (A6 guard);
  (e) `epsilon ≤ 0` never reports stalled.
- Generator under the seeded fixture: (f) a stall-prone setup stops at `< maxGenerations` and yields
  exactly that many `OptimizeProgress` values, returning best-so-far (A6, A9); (g) with
  `stallWindow ≥ maxGenerations` (convergence disarmed) it yields exactly `maxGenerations` values
  (A7).
- `test/nesting/engine.test.ts`: `makeOptimizerConfig` defaults omitted fields
  (`maxGenerations = max(generations, 200)`, `stallWindow = 15`, `stallEpsilon = 0.005`), passes
  through provided values, handles **partial** overrides, and degenerate configs (window 0/1,
  window > cap, epsilon ≤ 0) still produce a terminating optimizer (A10).
  **GREEN**: In `optimizer.ts` add and **export** pure `hasStalled` with the divide-by-zero guard
  (`denom = max(|prev|, 1e-9)`); change `OptimizerConfig` to carry `maxGenerations`, `stallWindow`,
  `stallEpsilon` (replacing `generations`); update `DEFAULT_OPTIMIZER_CONFIG`; replace the
  `gen < config.generations` loop with `gen < maxGenerations` that pushes best fitness to a history and
  breaks on `hasStalled(...)`. In `engine.ts`, map the Phase 0 fields in `makeOptimizerConfig` with the
  defaults above (keep `NestingConfig.generations` as the cap baseline). Fitness stays strip-height on
  this branch (Slice B owns the objective) — the slice is green standalone.
  **REFACTOR**: Keep the loop body readable; `hasStalled` stays single-responsibility.
  **Files**: `src/lib/nesting/optimizer.ts` (loop, `OptimizerConfig`, `hasStalled`),
  `src/lib/nesting/engine.ts` (`makeOptimizerConfig` body), `test/nesting/optimizer.test.ts`,
  `test/nesting/engine.test.ts`
  **Commit**: `feat(nesting): convergence-based GA termination with stall window and safety cap`

## Build Progress

### Steps

- [ ] Slice A: Convergence-based GA termination + pure `hasStalled`

### Acceptance Criteria

- [ ] A6 Convergence stops early
- [ ] A7 Safety cap (disarmed → exactly maxGenerations)
- [ ] A8 Window guard (pure hasStalled)
- [ ] A9 Per-generation progress contract
- [ ] A10 Config threading (defaults, pass-through, partial, degenerate)
