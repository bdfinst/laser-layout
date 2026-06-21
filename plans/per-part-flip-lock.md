# Implementation prompt: per-part "lock orientation" (disable mirroring)

> Hand this to an implementing agent (or pick it up directly). It is a self-contained
> task description for adding a per-part control that keeps the nesting GA from **flipping**
> (mirroring) parts that must not be reflected. Scope is deliberately small and additive.

## Context

The nesting genetic algorithm (`src/lib/nesting/optimizer.ts`) searches over three genes
per part: **rotation angle**, **placement order**, and a **mirror flag**
(`Individual.mirrors: boolean[]`, feature #15). The mirror flag reflects the part across the
vertical axis before rotating (`reflectPolygon` in `src/lib/geometry/polygon.ts`,
applied in `src/lib/nesting/placement.ts` and carried on `PlacedPart.mirror`,
`src/lib/geometry/types.ts`). Today **every part is eligible to be mirrored** — the GA
randomizes, mutates, and crosses over the flag freely to minimize wasted area.

For most laser-cut outlines a mirrored placement is identical and harmless. But some parts
are **orientation-specific** and must not be flipped:

- engraving / text / logos,
- a part with a finished "good side" or grain/coating that must face up,
- asymmetric features (countersinks, chamfers, alignment marks) that only work one way.

There is currently no way to tell the nester "don't flip this part."

## Goal

Add a per-part **"Lock orientation"** toggle (equivalently "Allow flip", inverted). When a
part is locked, the GA must never place any instance of it mirrored; rotation and ordering
are unaffected. Default is **unlocked** (flipping allowed), preserving today's behavior and
density.

## Design

### Where the flag lives

Add an optional field to the part model and thread it through, **plus** persist the user's
choice in the store so it survives a re-dedup (which rebuilds `parts` when the matching
tolerance changes — see `runDedup` in `src/lib/stores/project.svelte.ts`).

1. `src/lib/geometry/types.ts` — add to `Part`:

   ```ts
   /** When true, the nester must not mirror/flip this part (orientation-specific). */
   lockOrientation?: boolean;
   ```

   `undefined`/`false` ⇒ flipping allowed (unchanged behavior).

2. `src/lib/stores/project.svelte.ts` — keep the user's choices in a
   `Map<string, boolean>` keyed by part id (mirror how `quantities` works), and re-apply it
   to `state.parts` after `runDedup()` so the toggle isn't lost when tolerance changes:
   - add `lockedOrientation: Map<string, boolean>` to `ProjectState` (default empty),
   - add `setLockOrientation(partId: string, locked: boolean)` that updates the map **and**
     the matching part in `state.parts` (replace the array / part object so Svelte 5 runes
     react), and clears `state.result`,
   - in `runDedup`, after computing `uniqueParts`, set each part's `lockOrientation` from
     the map (parts whose id is absent stay unlocked),
   - include the field when constructing parts so it flows into nesting.

3. `src/lib/nesting/engine.ts` — `expandParts` already spreads `...part`, so the flag
   propagates to every expanded instance automatically. Confirm `lockOrientation` survives
   `simplifyPartsForNesting` (it also spreads `...part`) and `withOriginalGeometry`.

### Enforcing it in the GA (`src/lib/nesting/optimizer.ts`)

The result must **never** mirror a locked part, and ideally the GA shouldn't waste search on
a dead gene. Do both:

- **Hard guarantee at consumption:** in `toOrderedParts`, force the flag off for locked
  parts:
  ```ts
  mirror: parts[idx].lockOrientation ? false : individual.mirrors[i],
  ```
  This alone guarantees correctness regardless of gene state.
- **Avoid wasted search:** when generating/mutating the `mirrors` gene
  (`createRandomIndividual`, `mutate`, and the crossover in `crossover`), keep the flag
  `false` for any part index whose part is locked. Note `mirrors` is indexed by **position
  in `order`** in `toOrderedParts` (`individual.mirrors[i]` against `order[i] = idx`), so be
  careful: the lock is a property of the **part index**, not the order position. The
  simplest robust fix is the consumption-time clamp above (which is by `idx`); the
  gene-level optimization is secondary and must use the same part-index mapping or it will
  be wrong. **If in doubt, ship only the consumption-time clamp** — it is correct and
  sufficient; treat the gene-level skip as an optional optimization with its own test.

### UI (`src/lib/components/PartList.svelte`)

Add a per-row control to each `.part-row`: a checkbox labelled **"Lock orientation"** (or a
small lock icon/toggle) bound to `projectStore.state.parts[i].lockOrientation`, calling
`projectStore.setLockOrientation(part.id, checked)`. Place it near the quantity input. Give
it a stable selector for e2e (e.g. `.lock-orientation input` or `id={`lock-${part.id}`}`).
Add a one-line hint: "Locked parts are never flipped during nesting."

Keep styling consistent with the existing part-row controls.

## Files to change

- `src/lib/geometry/types.ts` — `Part.lockOrientation`.
- `src/lib/stores/project.svelte.ts` — `lockedOrientation` map, `setLockOrientation`,
  re-apply in `runDedup`, reset in `reset()`.
- `src/lib/nesting/optimizer.ts` — clamp mirror for locked parts (and optional gene skip).
- `src/lib/components/PartList.svelte` — per-part toggle + hint.
- Tests (below).

## Tests

Unit (vitest, `test/` mirrors `src/lib/`):

- `test/nesting/optimizer.test.ts` (or a new `test/nesting/lock-orientation.test.ts`):
  - Given parts where one has `lockOrientation: true`, run `optimize(...)` and assert **no
    `PlacedPart` for that part has `mirror === true`** across many generations/seeds.
  - A control part without the flag is still allowed to mirror (sanity: at least sometimes
    `mirror === true` over enough runs, or simply that the flag does not force it false).
- `test/stores/project.svelte.test.ts` (if store tests exist; otherwise add minimal):
  - `setLockOrientation` flips the part's flag and is preserved across a `runDedup`
    triggered by `setMatchTolerance`.

E2e (`e2e/nesting.test.ts`):

- Upload the fixture, toggle "Lock orientation" on a part, nest with a short time limit
  (`setTimeLimit`), and assert the run completes. (Asserting _visually_ that a specific part
  isn't mirrored is brittle; the unit test owns that guarantee. The e2e just covers the
  control existing and not breaking the nest.)

## Acceptance criteria

- [ ] A per-part "Lock orientation" toggle appears in the Part List and persists through a
      tolerance change (re-dedup).
- [ ] With a part locked, **no placed instance of it is ever mirrored**, across seeds/generations (unit-proven).
- [ ] Unlocked parts behave exactly as today; default is unlocked, so existing density/tests
      are unchanged.
- [ ] `npm run lint`, `npm run check`, `npm test` green; `npx playwright test` green
      (CI mode). No change to `bench` numbers (the flag is unset there).

## BDD

```gherkin
Scenario: A locked part is never flipped
  Given a part marked "Lock orientation"
  When the layout is nested
  Then no placed instance of that part is mirrored
  And its rotation and placement are still optimized

Scenario: Locking survives a tolerance change
  Given a part marked "Lock orientation"
  When the shape-matching tolerance is changed (parts are re-deduplicated)
  Then the part is still marked "Lock orientation"
```

## Out of scope / notes

- No global "lock all" control (could be a trivial follow-up).
- This does not change rotation handling, only mirroring.
- Keep it additive and behind the per-part flag — the engine/bench defaults must not move.
