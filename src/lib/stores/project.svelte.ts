import type { Part, NestingConfig } from '$lib/geometry/types';
import type { NestingResult } from '$lib/nesting/engine';
import { deduplicateParts } from '$lib/geometry/dedup';

export type Units = 'mm' | 'in';

const MM_PER_INCH = 25.4;

export interface ProjectState {
	parts: Part[];
	rawParts: Part[]; // pre-dedup, for re-running dedup when tolerance changes
	quantities: Map<string, number>;
	config: NestingConfig;
	result: NestingResult | null;
	isNesting: boolean;
	generation: number;
	currentSheet: number;
	fileName: string;
	units: Units;
	matchTolerance: number; // fraction: 0.01 = 1%, 0.001 = 0.1%
}

const DEFAULT_CONFIG: NestingConfig = {
	sheet: { width: 300, height: 300 },
	kerf: 1,
	rotationSteps: 72,
	populationSize: 30,
	generations: 50
};

export function toDisplayUnits(mm: number, units: Units): number {
	return units === 'in' ? mm / MM_PER_INCH : mm;
}

export function fromDisplayUnits(val: number, units: Units): number {
	return units === 'in' ? val * MM_PER_INCH : val;
}

function createProjectStore() {
	let state = $state<ProjectState>({
		parts: [],
		rawParts: [],
		quantities: new Map(),
		config: { ...DEFAULT_CONFIG },
		result: null,
		isNesting: false,
		generation: 0,
		currentSheet: 0,
		fileName: '',
		units: 'mm',
		matchTolerance: 0.01
	});

	function runDedup() {
		if (state.rawParts.length === 0) return;
		const { uniqueParts, quantities } = deduplicateParts(state.rawParts, state.matchTolerance);
		state.parts = uniqueParts;
		state.quantities = quantities;
		state.result = null;
	}

	return {
		get state() { return state; },

		setParts(rawParts: Part[], fileName: string) {
			state.rawParts = rawParts;
			state.fileName = fileName;
			state.result = null;
			runDedup();
		},

		setQuantity(partId: string, qty: number) {
			state.quantities.set(partId, Math.max(0, qty));
			state.quantities = new Map(state.quantities);
		},

		setSheetWidth(widthMM: number) {
			state.config = { ...state.config, sheet: { ...state.config.sheet, width: widthMM } };
			state.result = null;
		},

		setSheetHeight(heightMM: number) {
			state.config = { ...state.config, sheet: { ...state.config.sheet, height: heightMM } };
			state.result = null;
		},

		setKerf(kerfMM: number) {
			state.config = { ...state.config, kerf: kerfMM };
			state.result = null;
		},

		setUnits(units: Units) {
			state.units = units;
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
				config: { ...DEFAULT_CONFIG },
				result: null,
				isNesting: false,
				generation: 0,
				currentSheet: 0,
				fileName: '',
				units: 'mm',
				matchTolerance: 0.01
			};
		}
	};
}

export const projectStore = createProjectStore();
