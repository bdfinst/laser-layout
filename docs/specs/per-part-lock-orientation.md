# Spec: Per-Part "Lock Orientation"

_Source: GitHub issue #33 (bdfinst/laser-layout)._

## Intent Description

The nesting genetic algorithm currently treats every part as eligible to be
mirrored (flipped across the vertical axis) to minimize wasted material. This is
harmless for symmetric outlines but wrong for orientation-specific parts:
engraving/text/logos, parts with a finished "good side" or grain, and asymmetric
features (countersinks, chamfers, alignment marks). There is no way today to tell
the nester "don't flip this part."

This change adds a per-part **"Lock orientation"** toggle. When a part is locked,
the nester must never place any instance of it mirrored; rotation and placement
ordering remain fully optimized. The default is **unlocked** (flipping allowed),
exactly preserving today's behavior and density. The user's choice persists in the
store so it survives a re-deduplication (which rebuilds `parts` when the matching
tolerance changes).

## Architecture Specification

- **`src/lib/geometry/types.ts`** — add optional `lockOrientation?: boolean` to
  `Part`. `undefined`/`false` ⇒ flipping allowed (unchanged behavior).
- **`src/lib/stores/project.svelte.ts`** — add `lockedOrientation: Map<string, boolean>`
  to `ProjectState` (mirroring `quantities`); add `setLockOrientation(partId, locked)`
  that updates the map **and** the matching part in `state.parts` (replacing
  array/object so Svelte 5 runes react) and clears `state.result`; re-apply the map
  onto `uniqueParts` in `runDedup`; reset the map in `reset()`.
- **`src/lib/nesting/optimizer.ts`** — **consumption-time clamp** in `toOrderedParts`:
  `mirror: parts[idx].lockOrientation ? false : individual.mirrors[i]`. This
  guarantees correctness regardless of gene state. The gene-level skip (in
  `createRandomIndividual`/`mutate`/`crossover`) is an **optional** secondary
  optimization, deferred unless trivially safe.
- **`src/lib/nesting/engine.ts`** — no code change expected; confirm `lockOrientation`
  survives `expandParts`, `simplifyPartsForNesting`, and `withOriginalGeometry`
  (all spread `...part`).
- **`src/lib/components/PartList.svelte`** — per-row "Lock orientation" checkbox near
  the quantity input, bound to the part, calling `setLockOrientation(part.id, checked)`;
  stable e2e selector (`id={`lock-${part.id}`}`); one-line hint "Locked parts are never
  flipped during nesting."
- **Constraint**: additive and behind the per-part flag; engine/bench defaults must not move.

## Acceptance Criteria

1. A per-part "Lock orientation" toggle appears in the Part List and persists through a
   tolerance change (re-dedup) — store unit test.
2. With a part locked, **no placed instance of it is ever mirrored** across
   seeds/generations — optimizer unit test.
3. A control (unlocked) part is not forced unmirrored by the flag — unit test.
4. Unlocked parts behave exactly as today; default is unlocked; existing density/bench
   numbers unchanged.
5. E2e: toggling the control and nesting with a short time limit completes without error.
6. `npm run lint`, `npm run check`, `npm test`, `npx playwright test` all green.

## Consistency Gate

- [x] Intent is unambiguous
- [x] Every behavior/goal maps to an acceptance criterion
- [x] Architecture constrains without over-engineering (optional gene-skip explicitly deferred)
- [x] Terminology consistent across artifacts (`lockOrientation` / `lockedOrientation` / "Lock orientation")
- [x] No contradictions between artifacts
