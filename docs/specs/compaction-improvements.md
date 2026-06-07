# Spec: Nesting Compaction Improvements

Follow-on work to `docs/specs/density-aware-nesting.md`. That change added convergence
termination, an honest true-area density metric, and gap-filling placement — but the
`npm run bench` benchmark (both LightBurn fixtures × 3 sheet sizes × 5 seeds) shows the
real ceiling: **sheet count never drops and `trueFill` tops out ~0.44–0.63, worst on the
irregular Hot Air Balloon (0.44)**. Root cause: placement reasons over **bounding boxes**,
not part shapes, so irregular parts pack as rectangles and can't interlock.

Each item below is an **independent vertical slice** with its own GitHub issue. All are
measured by `npm run bench` (the committed benchmark is the acceptance instrument).

## Shared context (cite in every slice)

- Placement: `bottomLeftFill` → `findBestPosition` (hole → origin → adjacent/gap → grid),
  `src/lib/nesting/placement.ts`.
- Collision: `checkOverlap` / `hasCollision`, `src/lib/nesting/placement.ts:266-312`.
- NFP: `src/lib/nesting/nfp.ts` — `computeNFP` is **convex-only** Minkowski; also
  `insetPolygon`, `polygonsOverlap`, `polygonContainsPolygon`.
- GA: `optimizeIterative`, population seeding + `Individual` (rotations, order),
  `src/lib/nesting/optimizer.ts`.
- Data model: `PlacedPart { part, x, y, rotation }` — **no mirror field** (`types.ts:27-32`);
  exporters render via `getPlacedPolygons(pp)`, which applies the placement transform.
- Measurement: `npm run bench` → KPIs `usedArea` (lower=tighter), `trueFill` (higher=denser),
  `sheets`, `ms`. Compare a branch before/after; sheet count is the only true material KPI.

---

## Slice 1 — True-shape collision for kerf > 0  (impact: HIGH, effort: MEDIUM)

### Intent

`checkOverlap` deliberately treats **bounding-box** overlap (plus kerf margin) as a collision
whenever `kerf > 0` (`placement.ts:282-286`), an intentional speed approximation. The default
kerf is 1, so **the default packing path never uses true part shape** — irregular parts are
spaced as rectangles. Replace the kerf>0 path with a true-polygon spacing check (parts may
approach until their actual outlines are `kerf` apart), keeping the bbox test as a cheap
pre-filter.

### Architecture

- Add a polygon **outset/offset** (inflate by `kerf`) in `geometry/` or `nfp.ts` (mirror of the
  existing `insetPolygon`), OR a polygon–polygon minimum-distance test.
- In `checkOverlap`: keep the bbox+kerf early-reject (fast); when boxes are within kerf, do the
  exact test (`polygonsOverlap` on kerf-offset polygons, or min-distance ≥ kerf) instead of
  returning `true`.
- Hot path: `hasCollision` runs O(placed) per candidate per slide step — the bbox pre-filter must
  still eliminate the vast majority before any exact test.

### BDD

```gherkin
Scenario: Non-rectangular parts nest closer than their bounding boxes allow
  Given two concave parts whose bounding boxes are within kerf of each other
  But whose true outlines are at least kerf apart
  When they are placed with kerf > 0
  Then both are placed (not rejected) and their outlines are >= kerf apart

Scenario: Kerf spacing is still honored exactly
  Given any placement produced with kerf > 0
  Then no two placed polygons are closer than kerf
```

### Acceptance criteria

- [ ] On `npm run bench`, `trueFill` improves on ≥1 kerf>0 config (target the balloon) with no
      config regressing more than 0.01.
- [ ] No two placed polygons are closer than `kerf` (exact-geometry property test, replacing the
      bbox-only approximation).
- [ ] Benchmark `ms` stays within a generous budget (bbox pre-filter preserved; no >2× slowdown).
- [ ] Existing kerf tests updated to the exact-spacing invariant; full suite green.

---

## Slice 2 — Non-convex No-Fit-Polygon placement  (impact: HIGHEST, effort: HIGH)

### Intent

`computeNFP` only handles convex polygons (Minkowski sum). Real parts (the balloon) are concave,
so they can never settle into one another's concavities. Implement a non-convex NFP (orbiting
method, or convex decomposition + union of sub-NFPs) and use its vertices as candidate placement
positions, so concave parts interlock.

### Architecture

- Extend `nfp.ts` with non-convex NFP (orbiting sliding algorithm or decomposition).
- `findBestPosition` gains an NFP-derived candidate phase: positions are NFP vertices against the
  union of placed parts (or per-part NFP), scored bottom-left.
- Largest change in the set; can be phased (convex-decomposition first, orbiting later). Pairs with
  Slice 1 (both need true-shape geometry) — land Slice 1 first.

### BDD

```gherkin
Scenario: A concave part nests into another part's concavity
  Given a placed C-shaped part with an open pocket large enough for the next part
  When the next part is placed
  Then it is positioned inside the concavity, not only outside the bounding box
  And it does not overlap the placed part
```

### Acceptance criteria

- [ ] On `npm run bench`, the irregular fixture (Hot Air Balloon) `trueFill` improves by a
      meaningful margin (target ≥ +0.08 on ≥1 sheet size) OR uses fewer sheets.
- [ ] No overlaps (exact polygon test) across randomized inputs.
- [ ] Bounded runtime: benchmark completes within a documented budget (NFP is precomputable per
      unique part pair; cache it).
- [ ] Convex parts behave identically to today (no regression on the lego fixture).

---

## Slice 3 — Heuristic GA seeding (area / height descending)  (impact: MEDIUM, effort: LOW)

### Intent

The GA seeds its population with random individuals plus one identity ("no rotation, original
order"). Classic bottom-left-fill packs best **biggest-part-first**. Seed the initial population
with deterministic sorted orders (descending bounding-box area, descending height) so the GA
starts from strong solutions.

### Architecture

- In `optimizeIterative` init (`optimizer.ts`), replace a few random individuals with individuals
  whose `order` is parts sorted by descending area and by descending height (rotation 0).
- Pure, deterministic, no API change; remains seeded-RNG reproducible.

### BDD

```gherkin
Scenario: The initial population contains a biggest-first ordering
  Given a set of parts of varying sizes
  When the optimizer initializes its population
  Then one individual's order is the parts sorted by descending bounding-box area
```

### Acceptance criteria

- [ ] `npm run bench` `trueFill` ≥ current on every config, better on ≥1; `usedArea` never worse
      by >0.5%.
- [ ] Deterministic under the seeded RNG; full suite green.
- [ ] No change to `OptimizerConfig` or public signatures.

---

## Slice 4 — Iterate the bottom-left slide to a fixed point  (impact: MEDIUM, effort: LOW)

### Intent

`slideBottomLeft` does a single down-then-left pass (`placement.ts`). Alternating down/left until
no further movement settles a part deeper into L-shaped pockets that one pass misses.

### Architecture

- Wrap the two slide loops in an outer loop that repeats while the position changed, bounded by a
  small iteration cap. Reuse `hasCollision` (still enforces sheet bounds + overlap). `placement.ts`
  only.

### BDD

```gherkin
Scenario: A part settles to the bottom-left fixed point
  Given a placement where alternating a down move then a left move each frees the other
  When the part is slid
  Then it ends at the position where neither a further down nor left step is collision-free
```

### Acceptance criteria

- [ ] `npm run bench` `trueFill` ≥ current on every config, better on ≥1 gap-prone config.
- [ ] No overlaps; all parts inside the sheet (existing kerf-parameterized property test).
- [ ] Benchmark `ms` within budget (outer loop is bounded).

---

## Slice 5 — Mirror / reflection orientations  (impact: MEDIUM, effort: MEDIUM)

### Intent

Individuals encode rotation only. Asymmetric parts often nest better reflected. Add a per-part
mirror gene so the GA can flip parts.

### Architecture

- Add `mirror: boolean[]` to `Individual`; `crossover`/`mutate` handle the gene.
- Add `mirror?: boolean` to `PlacedPart` (`types.ts`) and apply reflection in the placement
  transform (`transformPartPolygons` / `getPlacedPolygons`) **before** rotation — so exporters
  (SVG, LightBurn) honor the flip automatically with no exporter changes.
- Add a `reflectPolygon` helper in `geometry/polygon.ts`.

### BDD

```gherkin
Scenario: A mirrored part renders reflected in the export
  Given a part placed with mirror = true
  When the layout is exported
  Then the exported geometry is the part reflected (then rotated/translated), matching the preview

Scenario: Mirroring never creates an overlap
  Given any placement that uses mirrored parts
  Then no two placed polygons overlap (respecting kerf)
```

### Acceptance criteria

- [ ] Placement transform and both exporters apply the mirror consistently (round-trip test:
      preview polygons == exported polygons).
- [ ] `npm run bench` `trueFill` ≥ current on every config (asymmetric parts may improve).
- [ ] No overlaps; full suite green; generator/worker contract unchanged.

---

## Slice 6 — Global multi-sheet assignment (reduce sheet count)  (impact: HIGH on material, effort: MEDIUM-HIGH)

### Intent

`nestPartsIterative` fills sheet 1 greedily, then overflows leftovers to the next sheet
(`engine.ts:125-160`). Parts are never **jointly** assigned across sheets, so a part that would
pack better with others on a later sheet is never reconsidered. This is the **only** item that can
reduce the number of stock sheets — the KPI the benchmark shows is currently never improved.

### Architecture

- Add a sheet-assignment strategy at the engine level: e.g. decreasing-area first-fit across an
  open set of sheets, or iterate candidate part→sheet partitions and keep the min-sheet result.
- Preserve the `nestPartsIterative` generator contract (per-generation progress to the worker/UI)
  and multi-sheet overflow semantics, or adapt the worker if the contract must change (call out
  explicitly).

### BDD

```gherkin
Scenario: A near-capacity part set fits on fewer sheets
  Given a part set whose total area is just over one sheet but which the greedy filler spreads
    across N sheets
  When global assignment runs
  Then the parts are nested onto fewer than N sheets
  And every part is still placed

Scenario: Per-generation progress is still reported
  Given nesting runs via the worker
  Then progress is still yielded as the engine works (contract preserved or adapted knowingly)
```

### Acceptance criteria

- [ ] On a fixture/config tuned near a sheet boundary, total `sheets` decreases on ≥1 case in
      `npm run bench`; no case uses more sheets.
- [ ] All parts still placed (no silent drops); overflow of genuinely-too-many parts preserved.
- [ ] Generator/worker progress contract preserved, or its change documented and the worker updated.
- [ ] Full suite green.

---

## Sequencing & notes

- **Cheap trio (3, 4, 5)** are independent and low-risk — do first, each validated on `npm run bench`.
- **Shape-aware unlock (1 → 2)**: land Slice 1 (true-shape kerf) before Slice 2 (non-convex NFP);
  they share geometry and 2 builds on 1. This is where the balloon's 0.44 `trueFill` ceiling lifts.
- **Slice 6** is orthogonal and targets sheet count directly (the real material saving).
- The already-shipped **density fitness** (`fitnessFromStats`) tested neutral *because* placement is
  shape-blind; Slices 1–2 are what let a density objective actually pay off.
- Each slice's acceptance is the benchmark delta — record before/after `npm run bench` in the PR.
