import { nestPartsIterative, type NestingInput, type NestingResult, type NestingProgress } from './engine';

export type WorkerMessage =
	| { type: 'start'; input: NestingInput }

export type WorkerResponse =
	| { type: 'progress'; currentSheet: number; generation: number; result: NestingResult }
	| { type: 'done'; result: NestingResult }
	| { type: 'error'; message: string }

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
	const msg = e.data;
	if (msg.type !== 'start') return;

	try {
		const raw = msg.input.quantities;
		let entries: [string, number][];
		if (raw instanceof Map) {
			entries = Array.from(raw.entries());
		} else if (Array.isArray(raw)) {
			entries = raw;
		} else {
			entries = Object.entries(raw as Record<string, number>).map(
				([k, v]) => [k, Number(v)]
			);
		}

		const input: NestingInput = {
			...msg.input,
			quantities: new Map(entries)
		};

		const gen = nestPartsIterative(input);

		function step() {
			try {
				const iter = gen.next();
				if (iter.done) {
					self.postMessage({ type: 'done', result: iter.value } satisfies WorkerResponse);
				} else {
					const progress: NestingProgress = iter.value;
					self.postMessage({
						type: 'progress',
						currentSheet: progress.currentSheet,
						generation: progress.generation,
						result: progress.result
					} satisfies WorkerResponse);
					setTimeout(step, 0);
				}
			} catch (err) {
				self.postMessage({
					type: 'error',
					message: err instanceof Error ? err.message : String(err)
				} satisfies WorkerResponse);
			}
		}

		step();
	} catch (err) {
		self.postMessage({
			type: 'error',
			message: err instanceof Error ? err.message : String(err)
		} satisfies WorkerResponse);
	}
};
