<script lang="ts">
	import { projectStore, toDisplayUnits, fromDisplayUnits, type Units } from '$lib/stores/project.svelte';

	function units(): Units {
		return projectStore.state.units;
	}

	function unitLabel(): string {
		return units() === 'in' ? 'in' : 'mm';
	}

	function displayWidth(): string {
		return toDisplayUnits(projectStore.state.config.sheet.width, units()).toFixed(units() === 'in' ? 2 : 0);
	}

	function displayHeight(): string {
		return toDisplayUnits(projectStore.state.config.sheet.height, units()).toFixed(units() === 'in' ? 2 : 0);
	}

	function displayKerf(): string {
		return toDisplayUnits(projectStore.state.config.kerf, units()).toFixed(units() === 'in' ? 3 : 1);
	}

	function onWidthChange(e: Event) {
		const val = parseFloat((e.target as HTMLInputElement).value);
		if (!isNaN(val) && val > 0) projectStore.setSheetWidth(fromDisplayUnits(val, units()));
	}

	function onHeightChange(e: Event) {
		const val = parseFloat((e.target as HTMLInputElement).value);
		if (!isNaN(val) && val > 0) projectStore.setSheetHeight(fromDisplayUnits(val, units()));
	}

	function onKerfChange(e: Event) {
		const val = parseFloat((e.target as HTMLInputElement).value);
		if (!isNaN(val) && val >= 0) projectStore.setKerf(fromDisplayUnits(val, units()));
	}

	function onUnitsChange(e: Event) {
		projectStore.setUnits((e.target as HTMLSelectElement).value as Units);
	}

	function onToleranceChange(e: Event) {
		const val = parseFloat((e.target as HTMLInputElement).value);
		if (!isNaN(val)) projectStore.setMatchTolerance(val / 100);
	}

	function tolerancePct(): string {
		return (projectStore.state.matchTolerance * 100).toFixed(1);
	}
</script>

<div class="material-settings">
	<h3>Material</h3>
	<div class="fields">
		<div class="field">
			<label for="units">Units</label>
			<select id="units" value={projectStore.state.units} onchange={onUnitsChange}>
				<option value="mm">Millimeters (mm)</option>
				<option value="in">Inches (in)</option>
			</select>
		</div>
		<div class="field">
			<label for="sheet-width">Width ({unitLabel()})</label>
			<input
				id="sheet-width"
				type="number"
				min="0.1"
				step={units() === 'in' ? '0.25' : '1'}
				value={displayWidth()}
				onchange={onWidthChange}
			/>
		</div>
		<div class="field">
			<label for="sheet-height">Height ({unitLabel()})</label>
			<input
				id="sheet-height"
				type="number"
				min="0.1"
				step={units() === 'in' ? '0.25' : '1'}
				value={displayHeight()}
				onchange={onHeightChange}
			/>
		</div>
		<div class="field">
			<label for="kerf">Kerf ({unitLabel()})</label>
			<input
				id="kerf"
				type="number"
				min="0"
				step={units() === 'in' ? '0.005' : '0.1'}
				value={displayKerf()}
				onchange={onKerfChange}
			/>
		</div>
	</div>

	<h3 class="section-heading">Shape Matching</h3>
	<div class="fields">
		<div class="field">
			<label for="tolerance">Tolerance ({tolerancePct()}%)</label>
			<input
				id="tolerance"
				type="range"
				min="0.1"
				max="1.0"
				step="0.1"
				value={tolerancePct()}
				oninput={onToleranceChange}
			/>
		</div>
		<div class="tolerance-hint">
			Shapes within {tolerancePct()}% of each other are treated as identical
		</div>
	</div>
</div>

<style>
	.material-settings {
		margin-top: 1rem;
	}

	h3 {
		margin: 0 0 0.5rem 0;
		font-size: 1rem;
		color: #333;
	}

	.section-heading {
		margin-top: 1rem;
	}

	.fields {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.field {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	label {
		font-size: 0.85rem;
		color: #555;
		min-width: 120px;
	}

	input[type="number"] {
		width: 5rem;
		padding: 0.3rem 0.4rem;
		border: 1px solid #ccc;
		border-radius: 4px;
		font-size: 0.85rem;
		text-align: right;
	}

	input[type="range"] {
		flex: 1;
		max-width: 120px;
	}

	select {
		padding: 0.3rem 0.4rem;
		border: 1px solid #ccc;
		border-radius: 4px;
		font-size: 0.85rem;
		background: white;
	}

	.tolerance-hint {
		font-size: 0.75rem;
		color: #888;
		padding-left: 120px;
	}
</style>
