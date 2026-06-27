---
id: lightburn-import-silently-drops-unrecognized-shapes
created: 2026-06-27T02:55:54Z
status: resolved
---

# LightBurn import silently drops unrecognized shapes (multi-layer groups, broken/open lines)

## Problem

- **Actual behavior**: A user uploaded a `.lbrn2` file containing grouped box
  templates across 3 layers (brand text, fold perforations, outline). Nothing
  was imported — the file appeared "not recognized" with no error, warning, or
  partial result. Only after deleting every layer except the outline AND
  "joining" the box-generator's broken-up line segments into closed paths did
  the import succeed.
- **Expected behavior**: The outline shapes should import (the perforation/brand
  layers may legitimately be filtered, but as outlines, not silently). When a
  file produces zero parts — or drops some shapes — the user should be told
  _what_ was dropped and _why_ (e.g. "12 shapes skipped: open paths", "layer
  'C00' not imported"), instead of getting a silent empty result.
- **Reproduction**:
  1. Export a `.lbrn2` from a box-generator whose outline is many separate
     2-point line segments (not a single joined/closed path), with extra
     perforation/brand layers, and import it → zero parts, no message.
  2. As a narrower repro of the layer cause: give an outline shape a `CutIndex`
     whose only `CutSetting` is `type="Tool"` (or absent from all Cut-type
     settings) → that shape is dropped.

## Root Cause Analysis

Two independent silent-drop paths in the LightBurn parser combine to produce the
empty import, and a third structural issue (no diagnostics) hides both:

1. **Open / broken paths are discarded.** Path geometry is assembled into a
   polygon and only kept when it has **≥ 3 points**; anything that assembles to
   fewer (or to nothing) is dropped with no record. A box generator that emits
   the outline as many disconnected 2-vertex line segments yields a 2-point
   polygon per segment, each below the threshold, so the whole outline vanishes.
   "Joining the lines" in LightBurn merges them into one closed path with ≥ 3
   vertices, which is why that step fixed it. Empty/missing primitive lists and
   unresolved shared-geometry (VertID/PrimID) references hit the same `[]` → drop
   path.

2. **Layer (CutIndex) filtering can drop everything.** The parser builds the set
   of "allowed" cut indices from the document's `CutSetting` elements, but
   **excludes any `CutSetting` of `type="Tool"`**. A top-level shape whose
   `CutIndex` is not in that allowed set is skipped entirely. If the outline
   layer happens to be backed only by a Tool-type cut setting (or a layer not
   registered as a Cut setting), every shape on it is filtered out — exactly the
   "remove the other layers and it works" symptom. (Note: this filter is applied
   only to top-level shapes, not to shapes nested inside a Group, so behavior
   also differs depending on whether the templates are grouped.)

3. **No import diagnostics.** The parse routine returns a plain `Part[]` and
   reports nothing about shapes it skipped, the per-layer counts, or why a file
   yielded zero parts. Every drop above is invisible, so the user can only guess
   (delete layers, rejoin lines) by trial and error.

Groups themselves are handled correctly (the walker recurses into group
children), so grouping is not itself the cause — but grouped + multi-layer +
broken-line together trip causes (1) and (2) at once.

Existing parser tests cover Rect/Ellipse, explicit `L`/`B` primitives, the
`LineClosed`/`Line` shorthand, groups, the shared geometry pool, and XForms.
They do **not** cover: open/2-point paths, empty/missing PrimList, unresolved
VertID/PrimID, CutIndex filtering when only Tool-type settings exist, or the
"zero parts produced" outcome.

## TDD Fix Plan

1. **RED**: Test that a `.lbrn2` whose outline is multiple separate 2-point line
   segments belonging to one logical closed contour imports as a usable part
   (≥ 3 points), rather than producing zero parts.
   **GREEN**: Before the `< 3 points` drop, stitch consecutive/coincident open
   segments sharing endpoints into a single polyline (within the existing
   geometry tolerance); accept the joined contour. Keep the ≥ 3 rule for
   genuinely degenerate geometry.

2. **RED**: Test that an outline shape whose `CutIndex` is backed only by a
   `type="Tool"` CutSetting (or by no Cut-type setting at all) is still
   imported, not filtered out.
   **GREEN**: Make the cut-index filter fail open — when the allowed set is empty
   or would exclude all shapes, import all shapes rather than none (and/or stop
   excluding Tool-type settings from the allowed set). Filtering should never be
   able to reduce the result to zero parts.

3. **RED**: Test that parsing returns import diagnostics — counts of shapes
   imported and skipped, with a reason per skip category (open-path,
   empty-primlist, unresolved-id, filtered-layer) — for a file mixing valid and
   invalid shapes.
   **GREEN**: Change the parser to return (or surface via a side channel) a small
   diagnostics summary alongside `Part[]`; thread it to the upload UI so a
   zero/partial import shows a human-readable message instead of nothing.

4. **RED**: Test that empty/missing PrimList and unresolved VertID/PrimID paths
   are reported as skipped-with-reason rather than silently absent.
   **GREEN**: Record these drops in the diagnostics from step 3.

**REFACTOR**: Extract the per-shape "why was this dropped" decision into one
named predicate/result type so the polygon-assembly path and the layer-filter
path feed a single diagnostics channel, keeping `processShape` readable.

## Acceptance Criteria

- [x] Root cause is addressed (not just symptom): broken/open outlines import,
      layer filtering cannot zero out the result, and drops are reported
- [x] All new tests pass
- [x] Existing tests still pass (LineClosed, groups, pool, XForm, Rect/Ellipse)
- [x] No regressions introduced — a valid multi-shape file imports the same
      parts as before, now with a diagnostics summary
