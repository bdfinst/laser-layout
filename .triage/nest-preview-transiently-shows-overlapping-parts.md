---
id: nest-preview-transiently-shows-overlapping-parts
created: 2026-06-27T02:55:54Z
status: open
---

# Nest preview transiently shows overlapping parts (full-fidelity render of a simplified-geometry candidate)

## Problem

- **Actual behavior**: While watching the live nest preview during the genetic
  algorithm, the user briefly saw one corner of a part (rotated ~45–50°)
  overlapping another part's edge. The overlap did not persist — later
  generations and the final stopped result showed no overlap.
- **Expected behavior**: The preview should never depict parts overlapping. A
  user watching the run should trust that what is drawn is collision-free, so a
  transient overlap doesn't undermine confidence in the final output (which is
  in fact correct).
- **Reproduction**: Run a density-mode nest with the NFP placement path on, with
  large-ish parts that the GA rotates near 45°. Intermittently (seed-dependent),
  an intermediate progress frame renders a corner interpenetration of a few
  tenths of a mm. A known seed in the existing regression
  (`test/nesting/nfp-fullfidelity-overlap.test.ts`, seed 7) produced ~0.295 mm
  interpenetration of this kind.

## Root Cause Analysis

This is a **preview rendering artifact**, not a flaw in the final layout's
collision correctness. The pipeline searches on **RDP-simplified** outlines
(tolerance ~1% of bounding box) to keep NFP/collision evaluation fast. On large
parts — and especially when a part is rotated near 45°, where its bounding box
(and thus the simplification tolerance) is largest — the simplified outline can
sit a fraction of a millimetre inside the true outline. The tight NFP feasible
seats place parts almost exactly kerf-apart on the _simplified_ shapes, so when
the _full-fidelity_ outline is restored for display, two parts can interpenetrate
slightly at a corner.

The final result is protected: after the GA finishes, a finalize step re-seats
placements on original geometry with exact (concave-correct) collision testing
and explicitly checks for any interpenetration, re-running placement if found.
The gap is that **intermediate progress frames are emitted with full-fidelity
geometry swapped in but BEFORE that finalize/re-seat runs** — finalize only runs
once per completed sheet, not per progress yield. So a mid-search candidate that
is collision-free on simplified shapes can be drawn overlapping on full-fidelity
shapes. As the GA explores away from that candidate (and certainly at finalize),
the overlap disappears — matching "it didn't repeat to the last generation."

The behavior that the _final_ output is overlap-free is already covered by the
full-fidelity-overlap regression test; there is **no** coverage asserting that
_progress/preview_ frames are non-interpenetrating.

## TDD Fix Plan

1. **RED**: Add a test that drives the iterative nest generator and, for the
   known overlap-producing seed, asserts that **every yielded intermediate
   placement** (not just the final one) is free of full-fidelity
   interpenetration — currently failing because intermediate frames skip the
   re-seat.
   **GREEN**: Before emitting a progress frame, run a cheap
   interpenetration check on the full-fidelity placement and, when it trips,
   either (a) emit the last known-good frame instead, or (b) apply the same
   re-seat used at finalize. Pick the option that keeps per-generation cost
   acceptable (a is cheaper; b is exact).

2. **RED**: Add a test that the chosen guard does not alter the final result for
   a non-overlapping seed (preview frames equal what they were before for the
   common case).
   **GREEN**: Gate the guard so it is a no-op when no interpenetration is
   detected, leaving the fast common path unchanged.

**REFACTOR**: Extract the "make this placement safe to display" step (full-
fidelity interpenetration check + fallback/re-seat) into one helper shared by the
progress-yield path and the finalize path, so preview and final use the same
correctness gate.

## Acceptance Criteria

- [ ] Root cause is addressed: intermediate preview frames are non-overlapping,
      not merely the final result
- [ ] All new tests pass (including the per-frame non-interpenetration assertion)
- [ ] Existing tests still pass (final-result full-fidelity-overlap regression)
- [ ] No regressions introduced — non-overlapping runs render identical previews
      and the per-generation cost stays acceptable
