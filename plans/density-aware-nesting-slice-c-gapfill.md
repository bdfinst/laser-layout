# Plan: Density-Aware Nesting — Slice C: Gap-Filling Placement

**Created**: 2026-06-07
**Branch**: `feat/density-nesting-slice-c` (worktree)
**Branches from**: Phase 0 commit (`refactor(nesting): extract stats module …`)
**Status**: approved
**Coordinator**: `plans/density-aware-nesting.md`
**Spec**: `docs/specs/density-aware-nesting.md`
**Shares files with**: none after Phase 0 (only `placement.ts`).

## Goal

Extend placement so a part can be slid into an open interior gap between already-placed parts —
interior-gap candidate anchors plus a coarse-step bottom-left slide — instead of only anchoring at
bounding-box corners. Hole/NFP placement remains highest priority; kerf semantics unchanged.

## Acceptance Criteria (this unit)

- [ ] A3 Gap-fill correctness: kerf=0 → no polygon overlap (bbox overlap allowed); kerf>0 → bbox separation ≥ kerf; all parts inside the sheet.

## Steps

### Slice C: Gap-filling placement — interior anchors + bottom-left slide

**Complexity**: complex
**RED**: In `test/nesting/placement.test.ts`: (a) **concrete fixture** — two placed rectangles
leaving a known W×H interior gap and a next part that fits it, plus an alternative corner at
`y > gap`; assert the part lands in the gap and strip height is unchanged; (b) property-style,
**parameterized by kerf**: for `kerf = 0` assert no two placed polygons overlap
(`polygonsOverlap == false`; overlapping bboxes allowed), for `kerf > 0` assert bbox separation
`≥ kerf`; all parts inside the sheet (A3); (c) hole placement still wins when a hole fits.
**GREEN**: In `placement.ts`, broaden adjacent-phase candidate anchors to include interior-gap
anchors (left-of/below each placed bbox and shared edges), then apply a **coarse-step** bottom-left
slide from each collision-free candidate (decrement y by a bounded step to collision, then x)
reusing `hasCollision`/`checkOverlap` unchanged; score by final `(y, x)`. Preserve phase order
(hole → origin → adjacent/grid). Slide granularity (coarse step, bounded iterations) is decided
here, not left open. Each slid candidate is validated by `hasCollision`, which also enforces the
sheet boundary, so out-of-sheet slides are rejected (no separate bounds check needed).
**REFACTOR**: Extract the slide/compaction into a named helper; deduplicate candidate generation. If
`placement.ts` passes ~400 lines, split collision/candidate-generation into a sibling module as a
conscious call.
**Files**: `src/lib/nesting/placement.ts`, `test/nesting/placement.test.ts`
**Commit**: `feat(nesting): gap-filling placement with interior anchors and bottom-left slide`

## Build Progress

### Steps

- [ ] Slice C: Gap-filling placement — interior anchors + bottom-left slide

### Acceptance Criteria

- [ ] A3 Gap-fill correctness (kerf=0 polygon, kerf>0 bbox separation, inside sheet)
