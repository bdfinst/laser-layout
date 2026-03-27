<script lang="ts">
	import { projectStore, toDisplayUnits } from '$lib/stores/project.svelte';
	import { getPlacedPolygons, toSVGPathD } from '$lib/geometry/polygon';
	import type { PlacedPart, SheetResult } from '$lib/geometry/types';

	const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e'];

	function getColor(index: number): string {
		return COLORS[index % COLORS.length];
	}

	function fmtDim(mm: number): string {
		const u = projectStore.state.units;
		return toDisplayUnits(mm, u).toFixed(u === 'in' ? 2 : 1) + ' ' + u;
	}
</script>

{#if projectStore.state.result}
	{@const result = projectStore.state.result}
	{@const isRunning = projectStore.state.isNesting}

	<div class="preview-container">
		<!-- Overall stats -->
		<div class="overall-stats" class:running={isRunning}>
			{#if isRunning}
				<span class="gen-badge">
					Sheet {projectStore.state.currentSheet + 1}, Gen {projectStore.state.generation + 1}/{projectStore.state.config.generations}
				</span>
			{/if}
			<span>Sheets: {result.sheets.length}</span>
			<span>Total placed: {result.totalPlaced}</span>
			{#if result.unplaced.length > 0}
				<span class="warning">Unplaced: {result.unplaced.length}</span>
			{/if}
		</div>

		<!-- Per-sheet layouts -->
		{#each result.sheets as sheet, sheetIdx}
			<div class="sheet-section">
				<div class="sheet-header">
					<span class="sheet-title">Sheet {sheet.sheetIndex + 1}</span>
					<span class="sheet-stat">Parts: {sheet.placed.length}</span>
					<span class="sheet-stat">Strip: {fmtDim(sheet.stripHeight)}</span>
					<span class="sheet-stat">Use: {(sheet.utilization * 100).toFixed(1)}%</span>
				</div>
				<div class="svg-wrapper">
					<svg
						viewBox="0 0 {result.sheetWidth} {result.sheetHeight}"
						xmlns="http://www.w3.org/2000/svg"
						class="layout-svg"
					>
						<rect x="0" y="0" width={result.sheetWidth} height={result.sheetHeight} fill="#fafafa" stroke="#999" stroke-width="0.5" />

						{#if sheet.stripHeight > 0 && sheet.stripHeight < result.sheetHeight}
							<line x1="0" y1={sheet.stripHeight} x2={result.sheetWidth} y2={sheet.stripHeight} stroke="#e74c3c" stroke-width="0.3" stroke-dasharray="3,3" />
						{/if}

						{#each sheet.placed as pp, i}
							{@const polygons = getPlacedPolygons(pp)}
							{#each polygons as poly}
								<path d={toSVGPathD(poly)} fill="{getColor(i)}22" stroke={getColor(i)} stroke-width="0.5" />
							{/each}
						{/each}
					</svg>
				</div>
			</div>
		{/each}
	</div>
{:else}
	<div class="preview-container empty">
		<span>Import a file and click "Nest" to preview the layout</span>
	</div>
{/if}

<style>
	.preview-container {
		border: 1px solid #ddd;
		border-radius: 8px;
		background: #fff;
		overflow: hidden;
	}

	.preview-container.empty {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 300px;
		color: #888;
		font-size: 0.9rem;
	}

	.overall-stats {
		display: flex;
		gap: 1rem;
		padding: 0.6rem 1rem;
		background: #f0f0f0;
		border-bottom: 1px solid #ddd;
		font-size: 0.85rem;
		font-weight: 600;
		color: #444;
		flex-wrap: wrap;
		align-items: center;
		transition: background 0.3s;
	}

	.overall-stats.running {
		background: #eef6ff;
		border-bottom-color: #c4ddf6;
	}

	.gen-badge {
		background: #4a90d9;
		color: white;
		padding: 0.15rem 0.5rem;
		border-radius: 10px;
		font-size: 0.75rem;
		font-weight: 600;
	}

	.warning {
		color: #e74c3c;
	}

	.sheet-section {
		border-top: 1px solid #eee;
	}

	.sheet-section:first-of-type {
		border-top: none;
	}

	.sheet-header {
		display: flex;
		gap: 1rem;
		padding: 0.4rem 1rem;
		background: #f8f8f8;
		border-bottom: 1px solid #eee;
		font-size: 0.8rem;
		color: #555;
		align-items: center;
	}

	.sheet-title {
		font-weight: 600;
		color: #333;
	}

	.sheet-stat {
		color: #666;
	}

	.svg-wrapper {
		padding: 0.75rem;
		display: flex;
		justify-content: center;
	}

	.layout-svg {
		width: 100%;
		max-height: 400px;
		border: 1px solid #eee;
	}
</style>
