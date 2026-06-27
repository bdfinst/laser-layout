import type { Part, NestingConfig, MaterialSheet } from '$lib/geometry/types';
import { availableSheets } from '$lib/geometry/types';
import type { NestingResult } from '$lib/nesting/engine';
import { deduplicateParts } from '$lib/geometry/dedup';
import { groupByContainment, removeCoincidentDuplicates } from '$lib/geometry/grouping';

export type Units = 'mm' | 'in';

const MM_PER_INCH = 25.4;

export interface ProjectState {
  parts: Part[];
  rawParts: Part[]; // pre-dedup, for re-running dedup when tolerance changes
  quantities: Map<string, number>;
  lockedOrientation: Map<string, boolean>; // per-part "never mirror" choice, survives re-dedup
  partPriority: Map<string, 'required' | 'optional'>; // per-part quantity priority, survives re-dedup
  grainConstrained: Map<string, boolean>; // per-part "0°/180° only" grain lock, survives re-dedup
  config: NestingConfig;
  result: NestingResult | null;
  isNesting: boolean;
  generation: number;
  currentSheet: number;
  fileName: string;
  matchTolerance: number; // fraction: 0.01 = 1%, 0.001 = 0.1%
}

const DEFAULT_CONFIG: NestingConfig = {
  sheet: { width: 508, height: 762 }, // 20 x 30 in (508 x 762 mm) — default stock size
  kerf: 1,
  rotationSteps: 72,
  populationSize: 30,
  generations: 50,
  // Density-first by default: search with NFP-based interlocking placement. Slower per
  // generation, but the app optimizes for material density over nesting speed (bounded by
  // the wall-clock budget below). Users can trade it back for speed in the UI.
  useNfpPlacement: true,
  timeBudgetMs: 60_000, // configurable wall-clock ceiling for a full nest
  commonLineCutting: false, // #43: opt-in shared-edge cutting; off by default
};

export function toDisplayUnits(mm: number, units: Units): number {
  return units === 'in' ? mm / MM_PER_INCH : mm;
}

export function fromDisplayUnits(val: number, units: Units): number {
  return units === 'in' ? val * MM_PER_INCH : val;
}

/**
 * Format a millimeter value showing both metric and imperial at once,
 * e.g. `508 mm / 20.00 in`. Used for read-only dimension displays.
 */
export function formatDual(mm: number, mmDecimals = 1, inDecimals = 2): string {
  return `${mm.toFixed(mmDecimals)} mm / ${toDisplayUnits(mm, 'in').toFixed(inDecimals)} in`;
}

function createProjectStore() {
  let state = $state<ProjectState>({
    parts: [],
    rawParts: [],
    quantities: new Map(),
    lockedOrientation: new Map(),
    partPriority: new Map(),
    grainConstrained: new Map(),
    config: { ...DEFAULT_CONFIG },
    result: null,
    isNesting: false,
    generation: 0,
    currentSheet: 0,
    fileName: '',
    matchTolerance: 0.01,
  });

  /**
   * Write the sheet-size list into config as the authoritative `sheets` source, keeping the
   * legacy single `sheet` synced to the first size for back-compat reads. Always keeps ≥1 size
   * and invalidates any stale result.
   */
  function commitSheetSizes(sizes: MaterialSheet[]) {
    const safe = sizes.length > 0 ? sizes : [{ ...DEFAULT_CONFIG.sheet }];
    state.config = { ...state.config, sheets: safe, sheet: { ...safe[0] } };
    state.result = null;
  }

  function runDedup() {
    if (state.rawParts.length === 0) return;
    const { uniqueParts, quantities } = deduplicateParts(state.rawParts, state.matchTolerance);
    // Re-apply the user's per-part lock choices as a fresh array, so the choice survives a
    // tolerance-driven re-dedup. Parts whose id is absent from the map stay unlocked.
    state.parts = uniqueParts.map((part) => ({
      ...part,
      lockOrientation: state.lockedOrientation.get(part.id) ?? false,
      priority: state.partPriority.get(part.id) ?? 'required',
      grainConstraint: state.grainConstrained.get(part.id) ?? false,
    }));
    state.quantities = quantities;
    state.result = null;
  }

  return {
    get state() {
      return state;
    },

    setParts(rawParts: Part[], fileName: string) {
      // Clean up overlapping duplicate paths, then group geometrically-
      // contained shapes into their parent as cutouts, so a shape and its
      // interior cutouts nest as one part.
      state.rawParts = groupByContainment(removeCoincidentDuplicates(rawParts));
      state.fileName = fileName;
      state.result = null;
      runDedup();
    },

    setQuantity(partId: string, qty: number) {
      state.quantities.set(partId, Math.max(0, qty));
      state.quantities = new Map(state.quantities);
    },

    setLockOrientation(partId: string, locked: boolean) {
      state.lockedOrientation.set(partId, locked);
      state.lockedOrientation = new Map(state.lockedOrientation);
      // Replace the part object (and the array) so Svelte 5 runes react.
      state.parts = state.parts.map((p) =>
        p.id === partId ? { ...p, lockOrientation: locked } : p,
      );
      // A lock change alters which placements are valid, so a prior result is stale.
      // (Unlike setQuantity, which leaves the result for the user to re-run.)
      state.result = null;
    },

    setPriority(partId: string, priority: 'required' | 'optional') {
      state.partPriority.set(partId, priority);
      state.partPriority = new Map(state.partPriority);
      state.parts = state.parts.map((p) => (p.id === partId ? { ...p, priority } : p));
      // Priority changes which parts the engine may drop, so a prior result is stale.
      state.result = null;
    },

    setGrainConstraint(partId: string, on: boolean) {
      state.grainConstrained.set(partId, on);
      state.grainConstrained = new Map(state.grainConstrained);
      state.parts = state.parts.map((p) => (p.id === partId ? { ...p, grainConstraint: on } : p));
      // A grain change alters which rotations are valid, so a prior result is stale.
      state.result = null;
    },

    /**
     * The authoritative list of available material sheet sizes (all dimensions in mm).
     * Normalizes a legacy single `sheet` to a one-element list so callers always see a list.
     */
    get sheetSizes(): MaterialSheet[] {
      return availableSheets(state.config);
    },

    /** Append a new size, copy-forward of the last existing size's dimensions. */
    addSheetSize() {
      const sizes = availableSheets(state.config);
      const src = sizes[sizes.length - 1];
      commitSheetSizes([...sizes, { width: src.width, height: src.height }]);
    },

    /** Remove the size at `index`, but never the last remaining one. */
    removeSheetSize(index: number) {
      const sizes = availableSheets(state.config);
      if (sizes.length <= 1) return;
      commitSheetSizes(sizes.filter((_, i) => i !== index));
    },

    /** Edit one size's width and/or height (mm). No-op for an out-of-range index. */
    updateSheetSize(index: number, dims: { width?: number; height?: number }) {
      const sizes = availableSheets(state.config);
      if (index < 0 || index >= sizes.length) return;
      commitSheetSizes(sizes.map((s, i) => (i === index ? { ...s, ...dims } : s)));
    },

    /**
     * Set a size's "Max sheets" supply cap. `undefined`/blank clears the cap (unlimited);
     * a value below 1 is coerced up to 1. No-op for an out-of-range index.
     */
    setSheetMaxCount(index: number, maxCount: number | undefined) {
      const sizes = availableSheets(state.config);
      if (index < 0 || index >= sizes.length) return;
      commitSheetSizes(
        sizes.map((s, i) => {
          if (i !== index) return s;
          const next: MaterialSheet = { width: s.width, height: s.height };
          if (maxCount !== undefined && !Number.isNaN(maxCount)) {
            next.maxCount = Math.max(1, Math.round(maxCount));
          }
          return next;
        }),
      );
    },

    setGenerations(n: number) {
      const g = Math.max(1, Math.min(1000, Math.round(n)));
      state.config = { ...state.config, generations: g };
      state.result = null;
    },

    setUseNfpPlacement(on: boolean) {
      state.config = { ...state.config, useNfpPlacement: on };
      state.result = null;
    },

    setCommonLineCutting(on: boolean) {
      state.config = { ...state.config, commonLineCutting: on };
      state.result = null;
    },

    setTimeBudgetSeconds(seconds: number) {
      const ms = Math.max(1, Math.min(600, Math.round(seconds))) * 1000;
      state.config = { ...state.config, timeBudgetMs: ms };
      state.result = null;
    },

    setKerf(kerfMM: number) {
      state.config = { ...state.config, kerf: kerfMM };
      state.result = null;
    },

    setMatchTolerance(pct: number) {
      state.matchTolerance = Math.max(0.001, Math.min(0.01, pct));
      runDedup();
    },

    setNesting(isNesting: boolean) {
      state.isNesting = isNesting;
      if (isNesting) {
        state.generation = 0;
        state.currentSheet = 0;
      }
    },

    updateResult(result: NestingResult, generation: number, currentSheet: number) {
      state.result = result;
      state.generation = generation;
      state.currentSheet = currentSheet;
    },

    finishNesting(result: NestingResult) {
      state.result = result;
      state.isNesting = false;
      state.generation = 0;
      state.currentSheet = 0;
    },

    reset() {
      state = {
        parts: [],
        rawParts: [],
        quantities: new Map(),
        lockedOrientation: new Map(),
        partPriority: new Map(),
        grainConstrained: new Map(),
        config: { ...DEFAULT_CONFIG },
        result: null,
        isNesting: false,
        generation: 0,
        currentSheet: 0,
        fileName: '',
        matchTolerance: 0.01,
      };
    },
  };
}

export const projectStore = createProjectStore();
