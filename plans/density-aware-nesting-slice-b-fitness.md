# Plan: Density-Aware Nesting — Slice B: Density-Aware Fitness

**Created**: 2026-06-07
**Branch**: `feat/density-nesting-slice-b` (worktree)
**Branches from**: Phase 0 commit (`refactor(nesting): extract stats module …`)
**Status**: approved
**Coordinator**: `plans/density-aware-nesting.md`
**Spec**: `docs/specs/density-aware-nesting.md`
**Shares files with**: Slice A — both edit `optimizer.ts` but different functions (`evaluate` vs loop); merge is mechanical.

## Goal

Replace the strip-height-only objective with a density objective: minimize the open-area ratio of
the used region using **true polygon area**, keep the heavy unplaced penalty (feasibility
dominates), demote strip height to a tiebreaker. The number the GA minimizes and the reported
`utilization` come from one shared `openAreaStats` (`utilization = 1 − openAreaRatio`). The GA loop
stays fixed-count on this branch (Slice A owns termination).

## Acceptance Criteria (this unit)

- [x] A1 Density objective: pure `openAreaStats`/`fitnessFromStats` rank denser layouts better, true polygon area, finite worst-case fitness on empty placement (no NaN/∞).
- [x] A2 Feasibility dominates: any all-placed layout beats any layout with ≥1 unplaced part.
- [x] A12 Single source of truth: reported `SheetResult.utilization` == `1 − openAreaRatio` from the same `openAreaStats` the GA minimizes.

> **Determinism convention.** The units under test are the **exported pure** helpers `openAreaStats`
> and `fitnessFromStats` (no GA, no RNG). Any GA-driven assertion uses the seeded LCG fixture (seed 42).

## Steps

### Slice B: Density-aware fitness via `openAreaStats`

**Complexity**: complex
**RED**:

- `test/nesting/stats.test.ts`: extend with `openAreaStats(placed, sheet)` computing `partsArea`
  from **true polygon area** per the `polygons[0]=outer, polygons[1..]=cutouts` convention — cutout
  areas are **subtracted, not summed** (guard against the flat-`getPlacedPolygons` sum bug, since
  `polygonArea` is always positive). Assert a holed part reports `area(outer) − area(cutout)`,
  strictly less than `area(outer)` **and** less than its bbox area; `openAreaRatio =
(usedArea − partsArea)/usedArea` clamped to `[0,1]`; `utilization == 1 − openAreaRatio`; empty
  placement returns a defined identity (no NaN) (A1, A12).
- `test/nesting/optimizer.test.ts`: pure `fitnessFromStats(stats, unplacedCount, totalParts)`:
  (a) ranks the denser of two equal-feasibility layouts better; (b) any layout with ≥1 unplaced part
  is worse than any all-placed layout (A2); (c) strip height breaks ties between equally-dense,
  equal-count layouts; (d) empty placement → `totalParts * PENALTY_PER_UNPLACED + 1`, finite (A1).
- `test/nesting/engine.test.ts`: `SheetResult.utilization` from `buildSheetResult` equals
  `1 − openAreaRatio` of the same `openAreaStats` (A12).
  **GREEN**: Add **exported** pure `openAreaStats` to `stats.ts` (true area via `polygonArea` +
  `getPlacedPolygons`) and redefine `computeSheetStats`/`calculateUtilization` in terms of it. Rewrite
  `evaluate` (`optimizer.ts`) to call `openAreaStats` + a pure **exported** `fitnessFromStats` =
  `unplacedCount * PENALTY_PER_UNPLACED + openAreaRatio + STRIP_TIEBREAK * (stripHeight/sheet.height)`
  with `PENALTY_PER_UNPLACED ≥ 2`, `STRIP_TIEBREAK = 1e-3`, `openAreaRatio` defaulting to 1 on empty
  placement. Update any existing test asserting a specific `utilization` value to the new true-area
  baseline **on this branch** so the slice is green standalone. (Loop stays fixed-count here — Slice A
  owns termination.)
  **REFACTOR**: No duplicate area math remains; `placement.ts` untouched.
  **Files**: `src/lib/nesting/stats.ts` (`openAreaStats`), `src/lib/nesting/optimizer.ts` (`evaluate`,
  `fitnessFromStats`), `test/nesting/stats.test.ts`, `test/nesting/optimizer.test.ts`,
  `test/nesting/engine.test.ts`
  **Commit**: `feat(nesting): density-aware fitness using true-area open-area ratio`

## Build Progress

### Steps

- [x] Slice B: Density-aware fitness via `openAreaStats`

### Acceptance Criteria

- [x] A1 Density objective (pure helpers, true area, finite worst-case fitness)
- [x] A2 Feasibility dominates density
- [x] A12 Single source of truth (utilization == 1 − openAreaRatio)
