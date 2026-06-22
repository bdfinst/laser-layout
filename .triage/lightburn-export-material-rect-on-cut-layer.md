---
id: lightburn-export-material-rect-on-cut-layer
created: 2026-06-22T13:56:42Z
status: resolved
---

# LightBurn export: material rectangle should be on a tool layer, not a cut layer

## Problem

- **Actual behavior**: The LightBurn exporter emits the sheet/material rectangle
  on `CutIndex="1"` (output layer 01) and defines no `CutSetting` for that layer.
  Only one `CutSetting type="Cut"` (index 0) exists. On import the rectangle sits
  on an undefined output layer and would be sent to the laser as a cut.
- **Expected behavior**: The material rectangle is exported on a LightBurn tool
  layer (non-output T1/T2, e.g. `CutIndex="30"` with a matching
  `CutSetting type="Tool"`), so it is treated as a non-cutting guide. Part
  objects remain on the cut layer (`CutIndex="0"`).
- **Reproduction**: Export any layout to `.lbrn2` and inspect the output; the
  `<Shape Type="Rect">` carries `CutIndex="1"` and no `CutSetting` matches
  index 1. Covered by `test/exporters/lightburn-exporter.test.ts`.

## Root Cause Analysis

The LightBurn exporter writes a single `CutSetting type="Cut"` (index 0) used by
the part `Path` shapes, then hard-codes the sheet boundary `Rect` shape onto
`CutIndex="1"`. No `CutSetting` is emitted for index 1, so the rectangle lands on
an undefined output layer that LightBurn treats as cuttable. The fix is to add a
tool-layer `CutSetting` (`type="Tool"`, index 30 / "T1") and point the rectangle
at that index, leaving part shapes on index 0.

## TDD Fix Plan

1. **RED**: Write a test asserting the exported XML contains a tool-layer
   `CutSetting` (`type="Tool"`) whose `index` matches the rectangle's `CutIndex`
   (e.g. 30).
   **GREEN**: Emit a `<CutSetting type="Tool">` block with `<index Value="30"/>`
   alongside the existing cut setting.

2. **RED**: Write a test asserting the sheet `Rect` shape uses the tool-layer
   `CutIndex` (30) and is no longer on `CutIndex="1"`.
   **GREEN**: Change the rectangle line to `CutIndex="30"`.

3. **RED**: Write a test asserting no shape references an undefined layer — every
   `CutIndex` used by a `Shape` has a corresponding `CutSetting` index (0 and 30
   only).
   **GREEN**: Already satisfied by steps 1–2; tighten if needed.

4. **RED**: Keep/extend a test asserting part `Path` shapes remain on
   `CutIndex="0"`.
   **GREEN**: No change to part emission.

**REFACTOR**: Extract the tool-layer index (30) and layer name into a named
constant to avoid magic numbers across the `CutSetting` and `Rect` emission.

## Acceptance Criteria

- [ ] Root cause is addressed (not just symptom)
- [ ] All new tests pass
- [ ] Existing tests still pass
- [ ] No regressions introduced
