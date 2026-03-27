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
3. **Engine** (`nesting/engine.ts`) orchestrates multi-sheet nesting. `nestPartsIterative()` is a generator that fills one sheet at a time, yielding progress per GA generation. Parts that don't fit on the current sheet overflow to the next.
4. **Optimizer** (`nesting/optimizer.ts`) runs a genetic algorithm where each individual encodes part rotation angles + placement order. Fitness = strip height (lower is better).
5. **Placement** (`nesting/placement.ts`) implements bottom-left-fill using NFP (No-Fit Polygon) from `nesting/nfp.ts` — Minkowski sum approach for convex polygons.
6. **Web Worker** (`nesting/nesting-worker.ts`) runs `nestPartsIterative()` off the main thread, posting progress/done/error messages. The `Map` for quantities requires rehydration from serialized forms (Array or Object).
7. **Exporters** (`exporters/`) convert `NestingResult` back to SVG or LightBurn format.

### State Management

Single `projectStore` in `stores/project.svelte.ts` using Svelte 5 runes (`$state`). The store holds both `rawParts` (pre-dedup) and `parts` (post-dedup) so dedup can be re-run when tolerance changes. The store uses a closure-based factory pattern (not a class).

### Geometry Utilities

- `polygon.ts` — area, centroid, bounding box, convex hull, point-in-polygon
- `affine.ts` — 3x3 affine transform matrices (translate, rotate, scale, compose, apply to points)
- `simplify.ts` — Ramer-Douglas-Peucker polygon simplification (used to speed up NFP on complex shapes)

## Svelte 5 Notes

This project uses Svelte 5 with runes. Use `$state`, `$derived`, `$effect` — not the legacy `$:` reactive declarations or stores API.

## Test Environment

Unit tests run in jsdom via vitest. Test files are co-located next to their source (`*.test.ts`).
