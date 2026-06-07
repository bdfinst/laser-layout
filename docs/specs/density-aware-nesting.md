# Spec: Density-Aware Nesting with Convergence-Based GA Termination

> Source prompt: `PROMPT.md` (repo root). Grounded against current code on branch `main`.
> Scope decision: **single bundled spec** covering three behaviors. The plan delivers them as a
> **diamond**: a behavior-preserving Phase 0 foundation, then three parallel slices — convergence
> termination, density fitness, gap-filling placement — then a Join (UI + effectiveness capstone).
> The three behaviors are independently deliverable; bundling is an explicit, human-approved choice.

## Intent Description

The nesting optimizer currently minimizes **strip height only** — the max-Y extent of placed
parts (`evaluate()`, `src/lib/nesting/optimizer.ts:155-172`; `getStripHeight()`,
`src/lib/nesting/placement.ts:345-356`) — and runs a **fixed** number of GA generations with no
early stop (`for (let gen = 0; gen < config.generations; gen++)`,
`src/lib/nesting/optimizer.ts:69`). Placement only anchors parts at bottom-left bounding-box
corners of already-placed parts and never tucks a part into an interior gap
(`findBestPosition()` / `tryAdjacentPositions()`, `src/lib/nesting/placement.ts:179-261`).

This change makes the optimizer pack **denser** and stop **smarter**:

1. **Density-aware fitness.** Replace the strip-height objective with one that minimizes the
   _open-area ratio_ of the used region — `(usedArea − partsArea) / usedArea`, using **true
   polygon area** (outer minus cutouts) for `partsArea`. The heavy unplaced-part penalty is
   retained so feasibility still dominates; strip height becomes a small tiebreaker only.
2. **Gap-filling placement.** Extend placement so a part can be slid into an open gap between
   already-placed parts (bottom-left compaction + interior-gap candidate anchors), not just along
   bounding-box corners.
3. **Convergence-based termination.** Stop the GA when best fitness stalls (no meaningful relative
   improvement over a configurable window of generations), bounded by a safety cap so it always
   terminates.

The public generator contract (`optimizeIterative()` yields one `OptimizeProgress` per generation,
returns final `PlacedPart[]`), multi-sheet overflow, kerf semantics, and per-generation progress
reporting to the worker/UI are all preserved.

## User-Facing Behavior

"User" here is the engine/worker calling the nesting API and, transitively, the person watching
the nesting preview. Observable behavior = placements produced, progress yielded, and termination.

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

## Architecture Specification

### Components touched

| File                                                               | Change                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/geometry/types.ts`                                        | Add optional `NestingConfig` fields: `stallWindow?`, `stallEpsilon?`, `maxGenerations?`.                                                                                                                                                                                            |
| `src/lib/nesting/stats.ts` (**new**)                               | Single source of truth for the density metric. Exported pure `openAreaStats(placed, sheet)` → `{ stripHeight, partsArea, usedArea, openAreaRatio, utilization }` using **true polygon area**. `getStripHeight`, `computeSheetStats`, `calculateUtilization` move here.              |
| `src/lib/nesting/optimizer.ts`                                     | New density `evaluate()` (consumes `openAreaStats`); exported pure `fitnessFromStats()` for unit testing; convergence loop replacing fixed loop via exported pure `hasStalled()`; `OptimizerConfig` gains `stallWindow`, `stallEpsilon`, `maxGenerations` (replaces `generations`). |
| `src/lib/nesting/placement.ts`                                     | Gap-filling: interior-gap candidate anchors + bottom-left slide compaction. Re-exports stats symbols (or callers repoint) for back-compat.                                                                                                                                          |
| `src/lib/nesting/engine.ts`                                        | `makeOptimizerConfig()` maps the new fields with defaults; `buildSheetResult` keeps consuming the shared stats.                                                                                                                                                                     |
| `src/lib/components/LayoutPreview.svelte`, `ExportControls.svelte` | Progress indicator no longer divides by `config.generations` (now a cap baseline, not a run length).                                                                                                                                                                                |

No change to `nesting-worker.ts` (it only depends on the generator contract, which is preserved).

**Single source of truth.** The number the GA minimizes and the `utilization` reported to the
user (`SheetResult.utilization`, shown as "Use: X%" in `LayoutPreview.svelte`) MUST be defined by
the same function: `utilization = 1 − openAreaRatio`. `openAreaStats` is that one function; both
`evaluate` and `computeSheetStats`/`buildSheetResult` call it. This is a required deliverable, not
an optional refactor.

**Displayed-utilization semantics change.** Moving `partsArea` from bounding-box area to true
polygon area lowers the reported utilization for parts with cutouts (it now reflects real
material). This is intended. Non-regression baselines (A5) are recorded under the **new** metric so
the guard compares like-for-like.

### Interfaces

**Fitness (`evaluate`)** — lower is better, convention unchanged:

```
usedArea       = stripHeight(placed) * sheet.width
// true area, per the established polygons[0]=outer, polygons[1..]=cutouts convention.
// polygonArea() returns absolute (positive) area, so cutouts must be SUBTRACTED, not summed.
partsArea      = Σ over placed parts of [ polygonArea(placedPolys[0]) − Σ_{i≥1} polygonArea(placedPolys[i]) ]
openAreaRatio  = usedArea > 0 ? (usedArea − partsArea) / usedArea : 1     // [0,1], clamp ≥ 0
unplacedCount  = parts.length − placed.length
fitness        = unplacedCount * PENALTY_PER_UNPLACED            // PENALTY ≥ 1, dominates
                 + openAreaRatio                                 // primary in-region objective
                 + STRIP_TIEBREAK * (stripHeight / sheet.height) // tiny secondary tiebreaker
```

Constraints: `PENALTY_PER_UNPLACED` strictly greater than `max(openAreaRatio) + STRIP_TIEBREAK`
(i.e. ≥ 2) so one unplaced part always outranks any density/strip difference. `STRIP_TIEBREAK`
small (e.g. `1e-3`). `partsArea` clamped so `openAreaRatio ∈ [0, 1]` (rounding can make parts
area marginally exceed bbox-derived usedArea on tight packs).

**Convergence loop (`optimizeIterative`)** — stall logic extracted to a pure, exported helper:

```
hasStalled(history, window, epsilon):
  if history.length < window + 1: return false        // window guard
  prev = history[history.length - 1 - window]
  curr = history[history.length - 1]
  denom = max(|prev|, EPS_FLOOR)                       // divide-by-zero guard (EPS_FLOOR e.g. 1e-9)
  improvement = (prev − curr) / denom                 // lower fitness is better
  return improvement < epsilon                        // non-positive epsilon ⇒ effectively disarmed

for (gen = 0; gen < maxGenerations; gen++) {
  ... evolve, sort, yield one OptimizeProgress ...
  history.push(best.fitness)
  if (hasStalled(history, stallWindow, stallEpsilon)) break
}
return best placement
```

`hasStalled` is the deterministic unit under test for convergence logic (no GA, no RNG). The cap
(A7) is tested by **disarming** convergence (`stallWindow >= maxGenerations`), not by forcing
monotonic improvement (unrealizable under elitism).

`OptimizerConfig`: replace `generations: number` with
`{ maxGenerations: number; stallWindow: number; stallEpsilon: number }`. `DEFAULT_OPTIMIZER_CONFIG`
updated accordingly.

**Config mapping (`makeOptimizerConfig`)** — defaults preserve existing callers:

```
maxGenerations = config.maxGenerations ?? Math.max(config.generations, 200)
stallWindow    = config.stallWindow    ?? 15
stallEpsilon   = config.stallEpsilon   ?? 0.005   // 0.5% relative
```

`NestingConfig.generations` is retained (now the baseline for the cap, not a hard run length).

**Gap-filling placement** — extend the existing pipeline (`findBestPosition`,
`src/lib/nesting/placement.ts:238-261`) without removing prior phases:

- Keep phase order: hole placement → origin → adjacent/grid.
- In the adjacent phase, broaden candidate anchors to include interior-gap anchors (left-of and
  below each placed bbox, plus shared edges), then apply a **bottom-left slide**: from each
  collision-free candidate, decrement `y` until collision, then decrement `x` until collision
  (gravity toward origin). Score by final `(y, x)` so interior gaps that don't raise strip height
  win. Reuse `hasCollision`/`checkOverlap` unchanged (kerf semantics intact).

### Constraints

- **Generator contract preserved**: yields one `OptimizeProgress` per generation; returns final
  `PlacedPart[]`. Consumers `engine.ts:123-159` and `nesting-worker.ts:35-60` unchanged in shape.
- **Multi-sheet overflow preserved**: `nestPartsIterative` overflow loop (`engine.ts:109-162`)
  unchanged.
- **Kerf semantics preserved**: including the `kerf>0` bbox approximation in `checkOverlap`
  (`placement.ts:266-294`).
- **No over-engineering**: no NFP rewrite, no recursive hole nesting, no new GA operators beyond
  what the objective change requires.
- All four files' type and signature changes land together (no half-migrated config shape).
- **Determinism in tests**: every GA-driven test runs under the existing seeded-`Math.random` LCG
  fixture (seed 42); convergence _logic_ is tested through the pure `hasStalled` helper with no GA.
- **Slide cost bound**: the bottom-left slide uses a coarse step (not per-unit) with a bounded
  iteration count; `bottomLeftFill` runs once per individual per generation, and the cap raises the
  worst case from 50 to `maxGenerations` (≥200), so per-placement cost is decided up front and the
  capstone asserts a runtime budget.

## Acceptance Criteria

| #   | Criterion                 | Pass condition                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Density objective         | Exported pure `openAreaStats`/`fitnessFromStats` rank the denser of two equal-feasibility layouts better; `partsArea` uses true polygon area (outer − cutouts); empty placement yields a finite worst-case fitness (no NaN/∞). Unit test in `test/nesting/optimizer.test.ts` and `test/nesting/stats.test.ts`.                                       |
| A2  | Feasibility dominates     | An all-placed layout always beats any layout with ≥1 unplaced part, regardless of open-area ratio. Unit test.                                                                                                                                                                                                                                        |
| A3  | Gap-filling correctness   | For randomized/representative inputs: when `kerf = 0`, no two placed **polygons** overlap (exact test, bbox overlap allowed); when `kerf > 0`, bbox separation ≥ kerf. All parts inside the sheet. Property-style test in `test/nesting/placement.test.ts`.                                                                                          |
| A4  | Gap-filling effectiveness | On a representative fixture under a **pinned RNG seed**, utilization improves by **≥ 0.05 absolute** vs the recorded pre-change baseline, **or** the part set fits on **fewer sheets**. Baseline captured under the same seed and metric.                                                                                                            |
| A5  | Density non-regression    | On every existing fixture (pinned seed), post-change utilization is **≥ baseline − 0.01**, where baseline is recorded under the **new true-area metric**. And `totalPlaced` never decreases vs baseline.                                                                                                                                             |
| A6  | Convergence stops early   | On a stalling fitness history, `hasStalled` returns true and the optimizer terminates at `< maxGenerations`, returning best-so-far. `hasStalled` unit-tested directly; generator behavior under the seeded fixture.                                                                                                                                  |
| A7  | Safety cap bounds runtime | With convergence disarmed (`stallWindow >= maxGenerations`), the optimizer runs exactly `maxGenerations` generations; never unbounded. Unit test.                                                                                                                                                                                                    |
| A8  | Window guard              | `hasStalled` returns false when fewer than `stallWindow + 1` generations are recorded. Unit test (pure).                                                                                                                                                                                                                                             |
| A9  | Progress contract         | `optimizeIterative` yields exactly one `OptimizeProgress` per generation run (early-stopped or capped); each has `generation`, `bestFitness`, `bestPlacement`. Test under the seeded fixture.                                                                                                                                                        |
| A10 | Config threading          | New `NestingConfig` fields default correctly through `makeOptimizerConfig` (`maxGenerations = max(generations,200)`, `stallWindow = 15`, `stallEpsilon = 0.005`), pass through provided values, and handle **partial** overrides. Degenerate configs (window 0/1, window > cap, epsilon ≤ 0) still terminate. Test in `test/nesting/engine.test.ts`. |
| A11 | Overflow + kerf preserved | Existing multi-sheet overflow and kerf tests still pass unchanged.                                                                                                                                                                                                                                                                                   |
| A12 | Single source of truth    | Reported `SheetResult.utilization` equals `1 − openAreaRatio` from the same `openAreaStats` the GA minimizes. Test asserts the displayed metric and the optimized metric agree.                                                                                                                                                                      |
| A13 | Honest progress display   | `LayoutPreview.svelte` and `ExportControls.svelte` no longer present `Gen N / config.generations`; the indicator does not claim progress toward a total the convergent run will not reach.                                                                                                                                                           |
| A14 | Full gate green           | `npm run lint`, `npm run check`, `npm test` all pass.                                                                                                                                                                                                                                                                                                |

## Consistency Gate

- [x] Intent is unambiguous — fitness formula, area basis, convergence defaults, and gap-filling
      mechanism are all pinned to concrete definitions (the four resolved decisions).
- [x] Every behavior has a corresponding BDD scenario — density, feasibility dominance, tiebreak,
      empty placement, gap-fill, overlap safety, hole priority, stall stop, cap, window guard,
      per-generation progress, and all non-regression edges are each covered.
- [x] Architecture constrains without over-engineering — reuses NFP/hole/kerf machinery; no GA
      rewrite; changes scoped to four named files.
- [x] Terminology consistent across artifacts — `open-area ratio`, `true polygon area`,
      `stallWindow`, `stallEpsilon`, `maxGenerations`, `strip height`, `unplaced penalty` used
      identically throughout.
- [x] No contradictions between artifacts — generator/overflow/kerf preserved everywhere;
      acceptance criteria trace back to scenarios and intent.

**Verdict: PASS.** Specification is internally consistent and ready for planning.

### Scope note (raised, then accepted)

This bundles three independently-deliverable behaviors — a `/specs` scope signal (>3 files, 3
behaviors). The human explicitly chose a single bundled spec; `/plan` will sequence them as
separate TDD increments (convergence → fitness → gap-filling) so each can be committed and
validated on its own.
