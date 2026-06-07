# Plan: Save the spec-generation prompt to `PROMPT.md`

## Context

In an earlier design discussion we shaped (but did not yet specify) a change to the nesting
optimizer: instead of only minimizing **strip height**, it should minimize **open area /
material waste between parts**, and run the genetic algorithm **until convergence** (stall
detection) with a **safety cap** on generations — rather than the current fixed generation
count. The full scope spans three areas: placement (gap-filling), fitness (density-aware), and
GA termination (stall + cap).

Rather than generate the formal spec now, the user wants a **reusable, self-contained prompt
saved into the repo** so the spec can be generated later via the `/specs` workflow — in this
session or a fresh one, by anyone. This step produces only that prompt file. No spec is
generated and no source code changes here.

The prompt must be accurate about today's behavior so the later spec is grounded. Verified
current state:

- Fitness is strip height only: `evaluate()` returns `getStripHeight(placed) + unplacedPenalty`
  (`src/lib/nesting/optimizer.ts:155-172`).
- GA runs a fixed number of generations with no convergence check:
  `for (let gen = 0; gen < config.generations; gen++)` (`src/lib/nesting/optimizer.ts:69`);
  `generations`/`populationSize` come from `NestingConfig` (`src/lib/geometry/types.ts:41-47`)
  via `makeOptimizerConfig()` (`src/lib/nesting/engine.ts:59-66`).
- Placement does not actively fill gaps: `findBestPosition()` tries holes → origin → a fixed
  set of corners adjacent to placed parts' bounding boxes → coarse grid fallback
  (`src/lib/nesting/placement.ts:238-261`). A `utilization` ratio already exists in
  `computeSheetStats()` (`src/lib/nesting/placement.ts:317-339`) that a density fitness can reuse.

## Change

Create a single new file, `PROMPT.md`, at the repository root. No other files change.

```
repo root
└── PROMPT.md   ← new: self-contained /specs prompt (the only change)
```

The file contains the prompt verbatim, ready to paste/run later. Write exactly this content:

```markdown
# Spec request: density-aware nesting with convergence-based GA termination

Use the `/specs` workflow to produce a full implementation spec for the change described
below. This prompt is self-contained — do not assume access to the chat where it was authored.
Read the cited files first, then write the spec.

## Goal

Change the nesting optimizer so it **minimizes open area / material waste between placed
parts** (denser packing, fewer gaps), and runs the genetic algorithm **until it converges**
(stall detection) rather than for a fixed number of generations, bounded by a safety cap.

## Decisions already made (in scope)

1. **Density-aware fitness.** Replace the strip-height-only objective with one that rewards
   packing density / penalizes open area between parts. Keep the heavy penalty for unplaced
   parts so feasibility still dominates.
2. **Gap-filling placement.** Rewrite/extend placement so parts can be tucked into open gaps
   between already-placed parts, not just along bottom-left bounding-box corners.
3. **Convergence-based termination.** Stop the GA when the best fitness stalls (no meaningful
   improvement over a configurable number of generations) instead of always running the fixed
   count. Apply a safety cap (maximum generations) so it always terminates.

All three are in scope; the spec should cover placement + fitness + convergence together.

## Current behavior to change (cite these in the spec)

- **Fitness = strip height only.** `evaluate()` returns `getStripHeight(placed) + unplacedPenalty`
  — `src/lib/nesting/optimizer.ts:155-172`. `getStripHeight()` is the max-Y extent of placed
  parts — `src/lib/nesting/placement.ts:345-356`.
- **Fixed generation loop, no convergence.** `for (let gen = 0; gen < config.generations; gen++)`
  — `src/lib/nesting/optimizer.ts:69`. Config originates from `NestingConfig`
  (`src/lib/geometry/types.ts:41-47`) and is mapped in `makeOptimizerConfig()`
  (`src/lib/nesting/engine.ts:59-66`).
- **Placement does not fill interior gaps.** `findBestPosition()` tries holes → origin → fixed
  corners adjacent to placed parts → coarse grid fallback —
  `src/lib/nesting/placement.ts:238-261` (candidate generation in `tryAdjacentPositions()`,
  `src/lib/nesting/placement.ts:179-214`).
- **A utilization metric already exists** and can seed the density fitness:
  `computeSheetStats()` returns `{ stripHeight, utilization }` where
  `utilization = partsArea / (maxY * sheet.width)` — `src/lib/nesting/placement.ts:317-339`.

## Non-regression constraints

- Public surface used by the engine and worker must keep working: the `optimizeIterative()`
  generator contract (yields `OptimizeProgress` per generation, returns final `PlacedPart[]`)
  consumed in `src/lib/nesting/engine.ts:123-159` and driven step-by-step in
  `src/lib/nesting/nesting-worker.ts:35-60`. If the signature or config shape changes, update
  all callers and the `NestingConfig` type together.
- Multi-sheet overflow behavior must be preserved: parts that don't fit the current sheet still
  overflow to the next (`nestPartsIterative()`, `src/lib/nesting/engine.ts:109-162`).
- Kerf spacing semantics must be preserved (including the kerf>0 bounding-box approximation in
  `checkOverlap()`, `src/lib/nesting/placement.ts:266-294`).
- All existing unit tests must still pass, and progress reporting to the worker/UI must remain
  per-generation.

## Required `/specs` output

Produce the standard `/specs` artifacts, including:

- A goal statement and acceptance criteria covering all three areas (placement, fitness,
  convergence) with measurable density/utilization improvement on a representative case and a
  bounded worst-case runtime (safety cap).
- TDD step breakdown (RED/GREEN/REFACTOR) naming the files to touch — at minimum
  `src/lib/nesting/optimizer.ts`, `src/lib/nesting/placement.ts`, and any `NestingConfig`
  change in `src/lib/geometry/types.ts` plus its mapping in `src/lib/nesting/engine.ts` — with
  matching test files under `test/nesting/`.
- New config fields (e.g. stall window, max-generation cap, density weighting) with defaults,
  and how they thread from `NestingConfig` through `makeOptimizerConfig()` into the optimizer.
- The non-regression constraints above restated as explicit checks.
```

## Verification

- `PROMPT.md` exists at the repo root and contains the full prompt above.
- `git status --porcelain` shows exactly one entry: `?? PROMPT.md` (the working tree is
  otherwise clean — there is **no** untracked `.vscode/settings.json`; that note in the draft
  was stale).
- No files under `src/` change; `npm run lint`, `npm run check`, and `npm test` are not
  required for a docs-only change but should remain green if run.
