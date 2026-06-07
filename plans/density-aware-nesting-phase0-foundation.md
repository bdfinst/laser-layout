# Plan: Density-Aware Nesting — Phase 0: Foundation

**Created**: 2026-06-07
**Branch**: `feat/density-nesting-phase0` (off `main`; merges to the integration base `feat/density-aware-nesting`)
**Branches from**: `main`
**Status**: approved
**Coordinator**: `plans/density-aware-nesting.md`
**Spec**: `docs/specs/density-aware-nesting.md`

## Goal

Behavior-preserving foundation that the three parallel slices branch from: extract a `stats.ts`
module (move stats functions unchanged) and scaffold the optional convergence config fields
(declared, not yet consumed). No fitness, GA-loop, or placement logic changes — the suite stays
green, numbers identical to today.

## Acceptance Criteria (this unit)

- [ ] F1 `stats.ts` exists exporting `computeSheetStats`, `getStripHeight`, `calculateUtilization`,
      moved **unchanged** (still bbox area); `test/nesting/stats.test.ts` re-asserts identical numbers.
- [ ] F2 Imports repointed directly to `stats.ts` (`optimizer.ts`, `placement.ts`, `engine.ts`); no
      module re-exports another's symbols; `optimizer.ts` no longer imports `getStripHeight` from
      `placement`.
- [ ] F3 `NestingConfig` has optional `stallWindow?`, `stallEpsilon?`, `maxGenerations?` (declared,
      unused); `OptimizerConfig`, GA loop, `evaluate`, placement untouched.
- [ ] F4 Full suite + typecheck + lint green; behavior unchanged.

## Steps

### Phase 0: Foundation — extract `stats.ts` + config field scaffolding

**Complexity**: standard — behavior-preserving; no fitness, loop, or placement logic changes.
**RED**: `test/nesting/stats.test.ts` (new) re-asserts the **current** behavior of the moved
functions (`computeSheetStats`, `getStripHeight`, `calculateUtilization`) from their new home —
identical numbers to today (still bbox area at this phase). Existing optimizer/engine/placement
tests must stay green after the import repoint.
**GREEN**: Create `src/lib/nesting/stats.ts` and **move** `computeSheetStats`, `getStripHeight`,
`calculateUtilization` there **unchanged**. Repoint imports directly: `stats.ts` depends only on
geometry; `optimizer.ts`, `placement.ts`, `engine.ts` import from `stats.ts` (drop the
`getStripHeight` import from `placement` in `optimizer.ts`). No module re-exports another's symbols.
Add the optional `stallWindow?`, `stallEpsilon?`, `maxGenerations?` fields to `NestingConfig`
(`types.ts`) — declared but **not yet consumed** (Slice A wires them in). Leave `OptimizerConfig`,
the GA loop, `evaluate`, and placement untouched.
**REFACTOR**: None — this is the refactor.
**Files**: `src/lib/nesting/stats.ts` (new), `src/lib/geometry/types.ts`,
`src/lib/nesting/optimizer.ts` (imports only), `src/lib/nesting/placement.ts` (remove stats),
`src/lib/nesting/engine.ts` (import only), `test/nesting/stats.test.ts`
**Commit**: `refactor(nesting): extract stats module and scaffold convergence config fields`

## Build Progress

### Steps

- [x] Phase 0: Foundation — extract `stats.ts` + scaffold convergence config fields

### Acceptance Criteria

- [x] F1 stats.ts extracted unchanged + stats.test.ts re-asserts identical numbers
- [x] F2 imports repointed directly, no re-exports
- [x] F3 NestingConfig optional convergence fields declared (unused)
- [x] F4 suite + typecheck + lint green, behavior unchanged
