# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Laser Layout is a SvelteKit web app that optimizes 2D part nesting for laser cutting. Users upload SVG or LightBurn (.lbrn2) files, configure material sheet dimensions, and the app runs a genetic algorithm to pack parts efficiently across one or more sheets.

## Commands

- `npm run dev` — start dev server
- `npm run build` — production build
- `npm run lint` — ESLint (TypeScript + Svelte)
- `npm run check` — TypeScript + Svelte type checking
- `npm test` — run all unit tests (vitest)
- `npx vitest run src/lib/geometry/polygon.test.ts` — run a single test file
- `npx vitest run -t "test name"` — run a single test by name
- `npx playwright test` — e2e tests (builds app, serves on :4173)

## Pre-commit Hook

Husky runs on every commit: lint-staged (ESLint on staged `.ts`/`.svelte` files), `npm run check` (type checking), `npm test` (all unit tests). All three must pass.

## Architecture

### Data Flow

Upload (SVG/LightBurn) → Parser → `Part[]` → Deduplication → Project Store → Nesting Engine → `NestingResult` → Exporter (SVG/LightBurn)

### Core Types (`geometry/types.ts`)

Everything flows through `Part` (id, name, polygons) and `PlacedPart` (part + x/y/rotation). A `Polygon` is `Point[]`. All internal measurements are in mm; display units (mm/in) are converted at the store boundary.

### Nesting Pipeline

1. **Parsers** (`parsers/`) extract `Part[]` from uploaded files. The SVG parser handles `<path>`, `<rect>`, `<circle>`, `<ellipse>`, `<polygon>`, `<polyline>` with nested `<g>` transform inheritance. The LightBurn parser handles the `.lbrn2` XML format.
2. **Deduplication** (`geometry/dedup.ts`) identifies geometrically identical parts (within configurable tolerance) and collapses them into unique parts with quantity counts.
3. **Engine** (`nesting/engine.ts`) orchestrates multi-sheet nesting. `nestPartsIterative()` is a generator that fills one sheet at a time, yielding progress per GA generation. Parts that don't fit on the current sheet overflow to the next. `makeOptimizerConfig()` maps `NestingConfig` (incl. the optional `stallWindow`/`stallEpsilon`/`maxGenerations`) to the optimizer config, defaulting `maxGenerations = max(generations * 3, 120)`, `stallWindow = 15`, `stallEpsilon = 0.005`.
4. **Optimizer** (`nesting/optimizer.ts`) runs a genetic algorithm where each individual encodes part rotation angles + placement order. Fitness (lower is better) = `unplacedCount·PENALTY + openAreaRatio + gravityWeight·gravity + remnantWeight·(1−remnantRatio) + tiny·stripHeight` — minimizing open area / material waste, feasibility dominating. The GA stops on convergence (`hasStalled()`: no meaningful relative improvement over `stallWindow` generations) bounded by `maxGenerations`, rather than a fixed count.

   **Remnant-aware terms (#41).** Two small, tunable terms shape _where_ the leftover space lands so the offcut is reusable, not scrap. `gravity` (in [0,1], from `stats.gravityMetric`) is the area-weighted part centroid's distance from the (0,0) corner over the sheet diagonal — a mild pull that clusters parts so slack consolidates. `remnantRatio` (from `stats.remnantStats`) is the largest axis-aligned empty rectangle (coarse-grid histogram scan over part bounding boxes) as a fraction of sheet area; fitness rewards it via `1 − remnantRatio`. Both weights (`GRAVITY_WEIGHT`/`REMNANT_WEIGHT`, default `0.05`) are small relative to `openAreaRatio` so density and feasibility stay dominant, and are configurable via `NestingConfig.{gravityWeight,remnantWeight}` (0 disables a term). The terms are opt-in by presence in `fitnessFromStats` — omitting a metric contributes exactly 0, keeping legacy callers/baselines unchanged.

5. **Placement** (`nesting/placement.ts`) implements bottom-left-fill using NFP (No-Fit Polygon) from `nesting/nfp.ts` — Minkowski sum approach for convex polygons. Parts are tucked into interior gaps via extra candidate anchors plus a coarse bottom-left slide (not just bbox corners). The density metric lives in `nesting/stats.ts` (`openAreaStats`): `utilization = 1 − openAreaRatio` uses **true polygon area** (outer minus cutouts), so reported utilization for parts with cutouts is lower than (and more honest than) the old bounding-box approximation. `stats.ts` also exposes the remnant-aware metrics consumed by the GA fitness: `gravityMetric` (corner-pull compactness) and `remnantStats` (largest reusable rectangular offcut) — see the Optimizer note below (#41).
6. **Web Worker** (`nesting/nesting-worker.ts`) runs `nestPartsIterative()` off the main thread, posting progress/done/error messages. The `Map` for quantities requires rehydration from serialized forms (Array or Object).
7. **Exporters** (`exporters/`) convert `NestingResult` back to SVG or LightBurn format.

**Orbiting NFP (epic #24).** `nesting/orbiting-nfp.ts` computes the No-Fit Polygon of two _concave_ simple polygons via the orbiting/sliding algorithm (Burke et al.) — O(nA+nB) vertices that already include the deep concave seats the convex Minkowski `computeNFP` and the bbox/concavity anchors can't express (P1). `nesting/nfp-cache.ts` is a translation-invariant per-pair cache keyed by a quantized shape signature (P2). Both are covered by property/fuzz tests.

**NFP placement path (P3–P5), `NestingConfig.useNfpPlacement`.** When enabled, the **exact** collision phase of `bottomLeftFill` augments its anchors with full NFP touching seats (P3), selects among validated candidates by resulting strip height rather than pure bottom-left (P4, `resultingStrip`), and replaces the O(edgesA·edgesB) true-shape collision with a signed NFP-clearance test (`nfpClearance`, P5) that also expresses kerf as a clearance threshold. In density mode the optimizer also spends a larger share of generations in the exact/NFP phase (`exactBudget = maxGenerations/3`). The cache is created per sheet in the optimizer and shared across exact-phase evaluations; the fast bbox search and all non-opt-in callers are byte-for-byte unchanged. It is ~3–4× slower and does not yet reach the lego-shelves one-sheet KPI (the open tuning in #26), so the **engine/bench default is `false`** (tests and `bench/nesting-compaction.bench.ts`'s `lego-shelves[nfp=0|1]` rows stay comparable). The **app turns it on by default** — `DEFAULT_CONFIG.useNfpPlacement = true` — because the product optimizes for density over speed; a UI toggle ("Maximize density") trades it back.

**Density-first runtime budget.** Nesting runs off the main thread in `nesting-worker.ts`, which enforces a configurable wall-clock budget (`NestingConfig.timeBudgetMs`, default 60s, surfaced as a "Time limit (s)" control) — checked at generation boundaries, returning the best layout so far when reached. The user also controls the generation count and can **Stop** on demand (terminates the worker and keeps the best layout). Density mode disarms nothing else: convergence (`hasStalled`) can still end a sheet early.

### State Management

Single `projectStore` in `stores/project.svelte.ts` using Svelte 5 runes (`$state`). The store holds both `rawParts` (pre-dedup) and `parts` (post-dedup) so dedup can be re-run when tolerance changes. The store uses a closure-based factory pattern (not a class).

### Geometry Utilities

- `polygon.ts` — area, centroid, bounding box, convex hull, point-in-polygon
- `affine.ts` — 3x3 affine transform matrices (translate, rotate, scale, compose, apply to points)
- `simplify.ts` — Ramer-Douglas-Peucker polygon simplification (used to speed up NFP on complex shapes)

## Svelte 5 Notes

This project uses Svelte 5 with runes. Use `$state`, `$derived`, `$effect` — not the legacy `$:` reactive declarations or stores API.

## Test Environment

Unit tests run in jsdom via vitest. Test files live in `test/` mirroring the `src/lib/` structure (e.g., `test/nesting/placement.test.ts` tests `src/lib/nesting/placement.ts`). E2e tests live in `e2e/`.
