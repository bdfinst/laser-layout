<!-- spec-version: dev-team/specs 7.9.0 -->

# Spec: Decompose `orbitingNFP`

_Source: deferred code-review finding `corrections/complexity-orbitingNFP.json` (complexity-review, warning/high)._

## Intent Description

`orbitingNFP` in `src/lib/nesting/orbiting-nfp.ts` is a single ~132-line function
whose core is a stateful counter-loop (~4 levels of nesting) carrying shared mutable
orbit-cursor state (`refx`, `refy`, `offx`, `offy`, `Bo`, `prev`). It computes the
exterior No-Fit Polygon of two simple concave polygons by orbiting B around A. The
function is hard to read and modify because five distinct phases of the algorithm —
contact collection, slide-vector generation, longest-feasible-slide selection,
vector trimming/advance, and loop-closure detection — are interleaved inside one
loop body sharing a flat set of mutable locals.

This change **decomposes the loop into named helpers and bundles the orbit cursor
into a small struct**, purely to improve maintainability. It is a behaviour-preserving
refactor: the numerical output of `orbitingNFP` for every input must be identical,
not merely close. Nothing about the NFP algorithm, its tolerances, or its public
signature changes. No new capability is added.

The motivating risk that caused this to be deferred is the reason the spec exists:
the orbiting-NFP suite verifies _invariants_ (property/fuzz tests), not exact values,
and the lego integration baselines use deliberately wide tolerances — so a
behaviour-perturbing extraction could pass the existing tests undetected. The
acceptance criteria therefore make behaviour-equivalence the explicit, verified
deliverable rather than an assumed side effect.

## Architecture Specification

**Component**: `src/lib/nesting/orbiting-nfp.ts` — internal implementation only.

**Public surface (must not change)**:

- `export function orbitingNFP(staticPoly: Polygon, orbitingPoly: Polygon): Polygon | null`
  — same signature, same return convention (B-offset list, or `null` on orbit failure),
  same numeric results for all inputs.

**Decomposition** (per the finding's recommendation — preserve exact operation order):

- `collectContacts(A, Bo) -> Contact[]` — phase 1: the type-0/1/2 vertex/edge contact scan
  (lines ~322–335). `Contact = { type: 0 | 1 | 2; a: number; b: number }`.
- `slideVectorsFor(contact, A, Bo) -> SlideVector[]` — phase 2: the per-contact candidate
  slide directions (lines ~339–360). Accumulated across all contacts into the `vectors` list.
- `pickLongestSlide(vectors, A, Bo, prev) -> { translate: SlideVector | null; maxd: number }`
  — phase 3: zero/anti-parallel rejection + `polygonSlideDistance` longest-feasible selection
  (lines ~363–381).
- `hasReturnedToStart(refx, refy, trace, startx, starty) -> boolean` — phase 5: start-revisit
  and non-start-revisit loop-closure detection (lines ~402–412), or an equivalent split that
  preserves the two distinct break conditions.
- An **orbit-cursor struct** bundling `{ refx, refy, offx, offy, Bo }` to cut the shared-mutable-local
  count. `prev` (the previous slide vector) may live in the struct or remain a loop local; either
  is acceptable provided the threading is explicit.

**Constraints**:

- **Exact operation order preserved.** Helpers are extractions, not reorderings. The sequence —
  collect contacts → generate vectors → pick longest → trim & advance cursor → test closure → advance `Bo`
  — and all floating-point operations execute in the same order, so results are bit-identical.
- No change to tolerances (`almostEqual`, the `1e-4` anti-parallel threshold, `maxIter`), the
  start-alignment heuristic, the vector-trimming math, or the final B[0]-locus→offset conversion.
- No change to `prepare`, `polygonSlideDistance`, `segmentDistance`, `normalize`, or any other
  helper in the module.
- Module-internal only — no new exports beyond what is needed; the new helpers are not part of any
  public contract.

**Dependencies**: none added. No new files. No callers change.

## Acceptance Criteria

1. **Public signature unchanged**: `orbitingNFP(staticPoly, orbitingPoly)` keeps its exact
   signature and return convention. `npm run check` passes.
2. **Behaviour-equivalent — property/fuzz suite**: the existing orbiting-nfp property/fuzz tests
   pass unchanged (no test edits to accommodate the refactor). PASS/FAIL: all pre-existing
   `orbiting-nfp` tests green.
3. **Behaviour-equivalent — integration baselines**: the `lego-shelves[nfp=1]` integration
   baselines are unchanged — `trueFill` and sheet count identical to the pre-refactor values.
   PASS/FAIL: baseline diff is empty.
4. **Numeric identity (stronger than the suites)**: a characterization check over a set of concave
   polygon pairs (including pairs with shared horizontal edges and pairs where the orbit returns
   `null`) produces output identical to the pre-refactor `orbitingNFP` — same vertex count, same
   coordinates within exact equality (or `null` where the original returned `null`). This is the
   guard against the wide-tolerance blind spot and must be authored as part of the change if no
   existing test pins exact output.
5. **Complexity reduced**: `orbitingNFP`'s body is materially smaller (the five phases live in
   named helpers); nesting depth in the main loop is reduced. complexity-review no longer flags
   the function.
6. **No behavioural config/tolerance changes**: diff touches only `orbiting-nfp.ts`; no tolerance
   constants, `maxIter`, or algorithm parameters are altered.
7. **Full gate green**: `npm run lint`, `npm run check`, `npm test` all pass.

## Ambiguity Log

| Decision                                                       | Classification | Resolved By | Rationale / Answer                                                                                                                                                                                                  |
| -------------------------------------------------------------- | -------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strictness of "behaviour-preserving" — close vs. bit-identical | `inferable`    | inference   | The finding says "Preserve exact operation order" and "trueFill/sheet count unchanged." In a numerically-sensitive NFP core with invariant-only tests, the only defensible bar is exact equivalence; AC #4 pins it. |
| Where the `Contact`/`SlideVector` helper types live            | `inferable`    | inference   | Module-internal types in the same file, matching the existing `type SlideVector = Point` convention already in the file. No public type surface.                                                                    |
| Whether `prev` joins the cursor struct or stays a loop local   | `inferable`    | inference   | The finding bundles "the orbit cursor (refx, refy, offx, offy, Bo)"; `prev` is explicitly outside that list. Either placement is behaviour-neutral, so left to the implementer.                                     |
| Whether a new exact-output characterization test must be added | `inferable`    | inference   | The deferral reason _is_ that existing tests can't catch a perturbation; the only way to satisfy the intent's verification goal is to pin exact output (AC #4). Implied unambiguously by the stated risk.           |

## Consistency Gate

- [x] Intent is unambiguous — behaviour-preserving decomposition of one named function, no capability change.
- [x] Every behaviour/goal maps to an acceptance criterion — decomposition→AC5, equivalence→AC2/3/4, surface→AC1, hygiene→AC6/7.
- [x] Architecture constrains without over-engineering — pure extraction along the finding's five named helpers + cursor struct; no new files or exports beyond necessity.
- [x] Terminology consistent — phase names (collectContacts/slideVectorsFor/pickLongestSlide/hasReturnedToStart), cursor struct, B-offset convention used consistently.
- [x] No contradictions between artifacts.
- [x] Every gap/ambiguity finding is logged — all four classified `inferable` with rationale; none require stakeholder input.

**Verdict: PASS** — ready for `/plan`.
