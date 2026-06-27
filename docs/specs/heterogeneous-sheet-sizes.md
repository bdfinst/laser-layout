<!-- spec-version: 8.1.0 -->

# Spec: Heterogeneous Sheet Sizes

## Intent Description

Today a nesting job assumes one material sheet size: `NestingConfig` holds a
single `MaterialSheet`, and every opened sheet is that size. Users who cut from a
stock of differently-sized pre-cut sheets (the reporting user has 600×350 mm and
500×400 mm cardboard) cannot ask the app to use their real inventory — they must
run the nest once per size and compare by hand.

This feature lets a user define **multiple available sheet sizes**, each with an
optional **supply cap** (how many of that size they have on hand), and lets the
nesting engine **mix those sizes freely within a single run** — choosing, per
sheet it opens, which available size to use — to place all parts with the **least
total material waste**. Waste is the committed sheet area minus part area; since
part area is fixed per job, this is equivalent to minimizing the total area of
sheets committed. Sizes are treated as equally preferred: selection is driven
purely by the objective, with no built-in bias toward larger or cheaper stock.

A single-size job remains the degenerate case (a one-element size list) and must
behave exactly as it does today.

## Architecture Specification

**Affected components**

1. **Core types (`geometry/types.ts`)**
   - `NestingConfig` gains a list of available sheet sizes as the source of truth
     (e.g. `sheets: MaterialSheet[]`). The existing single `sheet` field is
     retained only as a backward-compatible convenience that normalizes to a
     one-element list; the engine reads the list.
   - `MaterialSheet` gains an optional supply cap (e.g. `maxCount?: number`).
     Omitted ⇒ unlimited supply of that size (this subsumes the "unlimited" case
     and preserves today's single-sheet behavior).
   - `SheetResult` gains its own dimensions (its `MaterialSheet`, or
     `sheetWidth`/`sheetHeight`) so each placed sheet records the size actually
     used — sizes now differ within one result.
   - `NestingResult` sheet dimensions become per-sheet; any single
     `sheetWidth`/`sheetHeight` on the result is either removed or downgraded to
     a non-authoritative default.

2. **Engine sheet-opening loop (`nesting/engine.ts`)**
   - `nestPartsIterative` / `nestParts`: when opening a new sheet, select among
     the still-in-supply sizes the one that yields the best marginal result under
     the objective (rather than always using `config.sheet`). Decrement that
     size's remaining supply.
   - Supply exhaustion: when no in-supply size can accept the next part, stop
     opening sheets; remaining parts (including `required`) become `unplaced`.
     This bounds the previously unbounded "required opens sheets forever" loop.
   - `usedArea`, `isBetterResult`: compute committed area per-sheet using each
     sheet's own dimensions. **Reorder the comparator to least-area-first**
     (feasibility → least total committed area → fewer sheets as tie-break). For
     a homogeneous size this is monotonic with sheet count, so single-size
     results are unchanged.
   - `sheetLowerBound` and the multi-start global-assignment sweep
     (`packIntoKSheets` and callers) generalize from one sheet area to a
     supply-constrained set of sizes.

3. **State / store (`stores/project.svelte.ts`, `components/MaterialSettings.svelte`)**
   - Replace the single width/height pair with an editable list of sizes
     (add/remove rows), each with width, height, and an optional max-count.
   - Store mutators operate on the list; display-unit (mm/in) conversion applies
     at the same boundary it does today.

4. **Web worker plumbing (`nesting/nesting-worker.ts`, `nesting-coordinator.ts`)**
   - Serialize/rehydrate the size list (and caps) across the worker boundary
     alongside the rest of `NestingConfig`.

5. **Exporters (`exporters/`)**
   - SVG and LightBurn export use each sheet's own dimensions rather than a
     single global sheet size.

**Constraints**

- Single-size jobs must be byte-for-byte unchanged (engine, bench, exports).
- No size preference and no cost model in this feature (equal-preference,
  area-only objective) — `requires` a deterministic tie-break only.
- Mixing is unconditional (no "prefer fewest distinct sizes" penalty) per the
  product decision.

## Acceptance Criteria

1. **Backward compatibility** — A job configured with exactly one sheet size
   produces the same sheets, placements, unplaced set, and exports as the current
   single-`MaterialSheet` implementation (existing engine/bench/export tests pass
   unchanged). PASS = no diff in existing test outputs.
2. **Multiple sizes accepted** — `NestingConfig` accepts ≥1 sheet sizes; the
   engine runs without error on a 2-size configuration. PASS = nest completes and
   returns a `NestingResult`.
3. **Mixed-size results** — Given a parts set and two sizes where mixing reduces
   committed area, the result contains sheets of more than one size, and each
   `SheetResult` reports the dimensions actually used. PASS = at least two
   distinct sheet sizes appear in `result.sheets` and each carries correct dims.
4. **Least-waste objective** — On a fixture where a smaller/mixed sheet selection
   yields less total committed area than any single-size run, the engine selects
   the lower-waste result. PASS = chosen result's total committed area ≤ that of
   each single-size baseline, with all parts placed.
5. **Supply caps respected** — With a per-size `maxCount`, the engine never opens
   more sheets of that size than its cap. PASS = count of each size in
   `result.sheets` ≤ its cap.
6. **Supply exhaustion → unplaced** — When capped supply across all sizes cannot
   hold every part, the unfittable parts (including `required`) are returned in
   `unplaced` rather than the engine opening a disallowed sheet or looping. PASS =
   no cap exceeded AND leftover parts appear in `unplaced`.
7. **Per-sheet export** — Each exported sheet (SVG and LightBurn) is emitted at
   its own sheet dimensions. PASS = exporter output for a mixed result encodes the
   correct width/height per sheet.
8. **UI round-trip** — Users can add, edit, and remove sheet sizes and set an
   optional max-count per size; values round-trip through the store's mm/in
   conversion. PASS = store reflects edited list in mm regardless of display unit.

## Ambiguity Log

| Decision                                                                   | Classification                  | Resolved By | Rationale / Answer                                                                                                                         |
| -------------------------------------------------------------------------- | ------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| May one run mix multiple sheet sizes, or pick one size per job?            | `requires-stakeholder-input`    | human       | **Mix sizes freely** — engine chooses per-sheet which available size to open.                                                              |
| Is per-size supply limited or unlimited?                                   | `requires-stakeholder-input`    | human       | **User sets a max per size**; omitted cap ⇒ unlimited (subsumes the unlimited case).                                                       |
| Objective when "fewest sheets" and "least waste" conflict                  | `requires-stakeholder-input`    | human       | **Least waste / committed area first**, fewer sheets as tie-break.                                                                         |
| Preference/bias between sizes on ties                                      | `requires-stakeholder-input`    | human       | **Equal** — pure objective only; no larger/cheaper bias.                                                                                   |
| Definition of "waste"                                                      | `inferable`                     | inference   | Committed sheet area − fixed part area; minimizing waste ≡ minimizing total committed sheet area, well-defined across heterogeneous sizes. |
| Single-size config must keep working                                       | `inferable`                     | inference   | Domain/back-compat: model a single size as a one-element list; existing tests/bench must not regress.                                      |
| Blank/omitted max-count meaning                                            | `inferable`                     | inference   | Omitted ⇒ unlimited supply of that size, matching today's uncapped single sheet.                                                           |
| `SheetResult` must carry its own dimensions                                | `inferable` (REFACTOR_REQUIRED) | inference   | Sizes differ within one result, so size can no longer be implied globally; result model and `usedArea` must read per-sheet dims.           |
| Reordering `isBetterResult` to area-first won't change single-size results | `inferable`                     | inference   | For one uniform size, total committed area is monotonic in sheet count, so the reordering is a no-op for homogeneous jobs.                 |
| Export uses per-sheet dimensions                                           | `inferable`                     | inference   | Direct consequence of mixed sizes; each cut file must match its physical stock.                                                            |

## Consistency Gate

- [x] Intent is unambiguous
- [x] Every behavior/goal maps to an acceptance criterion
- [x] Architecture constrains without over-engineering
- [x] Terminology consistent across artifacts
- [x] No contradictions between artifacts
- [x] Every gap/ambiguity finding is logged — inferable with rationale or resolved by human
