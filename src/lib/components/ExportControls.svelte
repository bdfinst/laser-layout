<script lang="ts">
	import { onDestroy } from 'svelte';
	import { projectStore } from '$lib/stores/project.svelte';
	import { exportToSVG } from '$lib/exporters/svg-exporter';
	import { exportToLightBurn } from '$lib/exporters/lightburn-exporter';
	import type { WorkerResponse } from '$lib/nesting/nesting-worker';

	let exportFormat = $state<'svg' | 'lightburn'>('svg');
	let worker: Worker | null = null;
	let currentRunId = 0;

	function teardownWorker() {
		if (worker) {
			worker.terminate();
			worker = null;
		}
	}

	function doNest() {
		const { parts, quantities, config } = projectStore.state;
		if (parts.length === 0) return;

		teardownWorker();
		projectStore.setNesting(true);

		const runId = ++currentRunId;

		worker = new Worker(
			new URL('../nesting/nesting-worker.ts', import.meta.url),
			{ type: 'module' }
		);

		worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
			// Ignore stale messages from a previous run
			if (runId !== currentRunId) return;

			const msg = e.data;
			if (msg.type === 'progress') {
				projectStore.updateResult(msg.result, msg.generation, msg.currentSheet);
			} else if (msg.type === 'done') {
				projectStore.finishNesting(msg.result);
				teardownWorker();
			} else if (msg.type === 'error') {
				console.error('Nesting worker error:', msg.message);
				projectStore.setNesting(false);
				teardownWorker();
			}
		};

		worker.onerror = (e) => {
			if (runId !== currentRunId) return;
			console.error('Nesting worker error:', e);
			projectStore.setNesting(false);
			teardownWorker();
		};

		// Deep-clone to strip Svelte $state proxies (not structured-cloneable)
		const serializedInput = JSON.parse(JSON.stringify({
			parts,
			quantities: Object.fromEntries(quantities),
			config
		}));

		worker.postMessage({ type: 'start', input: serializedInput });
	}

	function downloadFile(content: string, filename: string, mimeType: string) {
		const blob = new Blob([content], { type: mimeType });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 100);
	}

	function doExport() {
		const result = projectStore.state.result;
		if (!result) return;

		for (const sheet of result.sheets) {
			const suffix = result.sheets.length > 1 ? `-sheet-${sheet.sheetIndex + 1}` : '';
			if (exportFormat === 'svg') {
				const content = exportToSVG(sheet.placed, {
					sheetWidth: result.sheetWidth,
					sheetHeight: result.sheetHeight
				});
				downloadFile(content, `nested-layout${suffix}.svg`, 'image/svg+xml');
			} else {
				const content = exportToLightBurn(sheet.placed, {
					sheetWidth: result.sheetWidth,
					sheetHeight: result.sheetHeight
				});
				downloadFile(content, `nested-layout${suffix}.lbrn2`, 'application/xml');
			}
		}
	}

	function canNest(): boolean {
		return projectStore.state.parts.length > 0 && !projectStore.state.isNesting;
	}

	onDestroy(() => {
		teardownWorker();
		if (projectStore.state.isNesting) {
			projectStore.setNesting(false);
		}
	});
</script>

<div class="controls">
	<div class="buttons">
		<button
			class="nest-btn"
			onclick={doNest}
			disabled={!canNest()}
		>
			{#if projectStore.state.isNesting}
				Nesting... Sheet {projectStore.state.currentSheet + 1}, Gen {projectStore.state.generation + 1}/{projectStore.state.config.generations}
			{:else}
				Nest Parts
			{/if}
		</button>

		{#if projectStore.state.result && !projectStore.state.isNesting}
			<div class="export-group">
				<select bind:value={exportFormat}>
					<option value="svg">SVG</option>
					<option value="lightburn">LightBurn (.lbrn2)</option>
				</select>
				<button class="export-btn" onclick={doExport}>
					Export
				</button>
			</div>
		{/if}
	</div>
</div>

<style>
	.controls {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-top: 1rem;
	}

	.buttons {
		display: flex;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.nest-btn {
		padding: 0.6rem 1.5rem;
		background: #4a90d9;
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 0.95rem;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.2s;
	}

	.nest-btn:hover:not(:disabled) {
		background: #357abd;
	}

	.nest-btn:disabled {
		background: #b0c4de;
		cursor: not-allowed;
	}

	.export-group {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	select {
		padding: 0.4rem 0.6rem;
		border: 1px solid #ccc;
		border-radius: 4px;
		font-size: 0.85rem;
		background: white;
	}

	.export-btn {
		padding: 0.5rem 1rem;
		background: #2ecc71;
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 0.85rem;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.2s;
	}

	.export-btn:hover {
		background: #27ae60;
	}
</style>
