<!-- spec-version: dev-team/specs 7.9.0 -->

# Spec: Decompose `tryAdjacentPositions` (+ `PlacementContext`)

_Source: deferred code-review finding `corrections/complexity-tryAdjacentPositions.json` (complexity-review, warning/high) and its `related` structure-review data-clump note._

## Intent Description

`tryAdjacentPositions` in `src/lib/nesting/placement.ts` is a single ~138-line
function on the exact/NFP placement hot path that interleaves three distinct
responsibilities: assembling candidate positions from several sources (bbox-corner

- interior-gap anchors, concavity anchors, per-pair NFP touching anchors, and the
  NFP-union feasible-region vertices), scoring/filtering them to in-sheet candidates,
  and running the budgeted validate-and-slide loop. The mixing makes the function hard
  to read and risky to modify.

This change **decomposes `tryAdjacentPositions` into three named helpers** so it reads
`generate → score → heapify → validate`, and (paired, per the related structure-review
note) **bundles the repeated `(cache, sheet, kerf, exact, nfpCtx)` parameter tuple into
a `PlacementContext`** threaded through the placement functions that currently pass it
positionally. It is a behaviour-preserving refactor: per CLAUDE.md, `placement.ts`
changes must be byte-for-byte behaviour-preserving given the same RNG — the same parts,
seed, and config must produce identical placements. No scoring, budget, or algorithm
change is in scope.

This was deferred because the integration tests' wide tolerances cannot tightly verify
placement equivalence, so the acceptance criteria make identical-placement verification
(unit tests + bench rows) the explicit deliverable rather than an assumption.

## Architecture Specification

**Component**: `src/lib/nesting/placement.ts` — internal implementation only.

### Part A — decompose `tryAdjacentPositions`

Extract three helpers preserving exact behaviour and order:

- `collectCandidatePositions(cache, partBB, kerf, exact, nfpCtx) -> Point[]`
  — the candidate-generation block (lines ~660–710): legacy `candidateAnchors`, `exact`-gated
  `concavityAnchors`, per-pair `nfpCandidateAnchors`, and the `nfpCtx`-gated
  `feasibleVertices(forbidden, ifp, kerf, nfpCtx.cache.dilated)` NFP-union augmentation. Order of
  appends preserved (it only affects heap tiebreaks, which must stay identical).
- `filterAndScoreInSheet(positions, sheet, partBB, union, nfpCtx) -> ScoredPosition[]`
  — the in-sheet filter + `ScoredPosition` construction (lines ~716–731), using the same
  `resultingStrip(union, p.y, partBB.height)` (0 when `nfpCtx` absent) and `bl(x,y)` scores.
- `validateBest(heap, normalizedPoly, partBB, ctx) -> ScoredPosition | null` — the budgeted
  validate-and-slide loop (lines ~744–775): same `VALIDATE_BUDGET`/`SLIDE_BUDGET` (80/12 with NFP,
  40/6 without), same `hasCollision` gate, same `slideBottomLeft` settle, same `better` comparison,
  same `recordBudgetOutcome` diagnostic call.

`tryAdjacentPositions` then reads: build context → `collectCandidatePositions` →
`filterAndScoreInSheet` → `createPositionHeap` → `validateBest`.

**Invariants preserved exactly**: the `better` comparator (`a.strip - b.strip || a.bl - b.bl`
with NFP, else `a.bl - b.bl`), the heap construction (`createPositionHeap`), the validate/slide
budgets, the append order of candidate sources, and the `recordBudgetOutcome` call site/arguments.

### Part B — `PlacementContext` data-clump (paired)

Introduce `interface PlacementContext { cache: PlacedIndex; sheet: MaterialSheet; kerf: number; exact: boolean; nfpCtx?: NfpCtx }`
and thread it through the functions that currently pass the tuple positionally:
`hasCollision`, `checkOverlap`, `slideBottomLeft`, `tryAdjacentPositions`, `tryGridFallback`,
`findBestPosition`. This is a mechanical signature change — no logic moves and the values passed
are identical; it pairs naturally with Part A because the new helpers would otherwise re-thread the
same five params.

**Constraints**:

- Byte-for-byte behaviour-preserving given the same RNG (CLAUDE.md). Identical placements for the
  same parts/seed/config — both fast bbox path (`nfpCtx` absent) and exact NFP path.
- No change to scoring (`resultingStrip`, `bl`), budgets, anchor sources, the dilation cache usage,
  or the `feasibleVertices` call.
- Part B is mechanical and behaviour-neutral; if it introduces churn risk it may ship as a separate
  follow-up commit within the same change, but the two are specified together because they pair.
- `ScoredPosition` interface and `createPositionHeap` are reused unchanged.

**Dependencies**: none added. No new files (helpers + `PlacementContext` live in `placement.ts`).
No public engine/optimizer API changes — these are module-internal functions.

## Acceptance Criteria

1. **Identical placements — unit**: `test/nesting/placement.test.ts` passes unchanged (no test edits
   to accommodate the refactor). PASS/FAIL: all pre-existing placement tests green.
2. **Identical placements — bench**: `bench/nesting-compaction.bench.ts` `lego-shelves[nfp=0]` and
   `lego-shelves[nfp=1]` rows produce identical `trueFill` and sheet count to the pre-refactor run.
   PASS/FAIL: bench row values match the recorded baseline exactly.
3. **Both paths covered**: equivalence holds for both the fast bbox path (`nfpCtx` undefined) and the
   exact NFP path (`nfpCtx` present) — verified by the `nfp=0` and `nfp=1` bench rows respectively.
4. **`tryAdjacentPositions` decomposed**: the function delegates to `collectCandidatePositions`,
   `filterAndScoreInSheet`, and `validateBest`; its body reads generate→score→heapify→validate.
   complexity-review no longer flags it.
5. **`PlacementContext` threaded**: `hasCollision`, `checkOverlap`, `slideBottomLeft`,
   `tryAdjacentPositions`, `tryGridFallback`, `findBestPosition` accept the bundled context; the
   five-element positional tuple no longer recurs across their signatures.
6. **No behavioural-param changes**: diff touches only `placement.ts`; no budget, scoring, tolerance,
   or anchor-source change.
7. **Full gate green**: `npm run lint`, `npm run check`, `npm test` pass, and `npm run bench`
   completes with matching rows.

## Ambiguity Log

| Decision                                                                  | Classification | Resolved By | Rationale / Answer                                                                                                                                                                                                               |
| ------------------------------------------------------------------------- | -------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strictness of equivalence — close vs. byte-identical placements           | `inferable`    | inference   | CLAUDE.md mandates `placement.ts` refactors be "byte-for-byte behaviour-preserving given the same RNG." Not a judgment call.                                                                                                     |
| Whether Part B (`PlacementContext`) is in scope of this spec              | `inferable`    | inference   | The finding's `related` note says the data-clump "Pairs naturally with this extraction"; the user selected the complexity refactors. Bundled as one coherent change, with an explicit option to split B into a follow-up commit. |
| How `validateBest` receives the many params (arg list vs. context object) | `inferable`    | inference   | Part B introduces `PlacementContext`; passing it to `validateBest` is the consistent choice and the reason the two pair. Behaviour-neutral.                                                                                      |
| Whether candidate-source append order matters                             | `inferable`    | inference   | Append order feeds heap tiebreaks under an equal `strip`/`bl`; preserving it is required by byte-for-byte equivalence, so it is fixed, not optional.                                                                             |

## Consistency Gate

- [x] Intent is unambiguous — behaviour-preserving decomposition + mechanical param bundling, no algorithm change.
- [x] Every behaviour/goal maps to an acceptance criterion — decompose→AC4, context→AC5, equivalence→AC1/2/3, hygiene→AC6/7.
- [x] Architecture constrains without over-engineering — three named helpers along the finding's lines + one interface; no new files, no public API change.
- [x] Terminology consistent — helper names and `PlacementContext` match the finding; scoring terms (`resultingStrip`, `bl`, `better`) reused verbatim.
- [x] No contradictions between artifacts.
- [x] Every gap/ambiguity finding is logged — all four `inferable` with rationale; none require stakeholder input.

**Verdict: PASS** — ready for `/plan`.

## Amendments (post-plan-review, 2026-06-25)

Resolved during `/plan` review; these supersede the body text where they conflict, so a
spec-compliance reviewer should treat them as authoritative:

1. **`PlacementContext` field name**: the bundled `PlacedIndex` is named **`index`**, not `cache`,
   to avoid a readability collision with `NfpCtx.cache` (an `NfpCache`). All other fields unchanged.
2. **`checkOverlap` threading is partial**: `checkOverlap` keeps its per-call `placements` argument
   (a `cache.query()` result, not a tuple member) and additionally receives the context, reading only
   `ctx.kerf`/`ctx.exact`/`ctx.nfpCtx`. AC #5's "threaded through `checkOverlap`" is satisfied in this
   partial form.
3. **`collectCandidatePositions` signature**: takes `(partBB, ctx)` (the bundled form), superseding the
   positional `(cache, partBB, kerf, exact, nfpCtx)` written in Part A — which predates `PlacementContext`.
4. **Bench is confirmatory, not a CI gate**: AC #2/#7's bench-row equivalence is verified by running the
   bench and comparing rows to a pre-refactor run (no stored CI baseline). The exact-placement
   characterization net is the mechanical equivalence gate and is strictly stronger (identical placements
   ⇒ identical bench rows).
