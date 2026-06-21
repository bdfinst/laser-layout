import type { Part, NestingConfig } from '$lib/geometry/types';
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
    config: { ...DEFAULT_CONFIG },
    result: null,
    isNesting: false,
    generation: 0,
    currentSheet: 0,
    fileName: '',
    matchTolerance: 0.01,
  });

  function runDedup() {
    if (state.rawParts.length === 0) return;
    const { uniqueParts, quantities } = deduplicateParts(state.rawParts, state.matchTolerance);
    // Re-apply the user's per-part lock choices as a fresh array, so the choice survives a
    // tolerance-driven re-dedup. Parts whose id is absent from the map stay unlocked.
    state.parts = uniqueParts.map((part) => ({
      ...part,
      lockOrientation: state.lockedOrientation.get(part.id) ?? false,
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

    setSheetWidth(widthMM: number) {
      state.config = { ...state.config, sheet: { ...state.config.sheet, width: widthMM } };
      state.result = null;
    },

    setSheetHeight(heightMM: number) {
      state.config = { ...state.config, sheet: { ...state.config.sheet, height: heightMM } };
      state.result = null;
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
