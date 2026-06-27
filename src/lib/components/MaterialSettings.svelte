<script lang="ts">
  import { tick } from 'svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import DimensionInput from './DimensionInput.svelte';
  import { tooltip } from '$lib/actions/tooltip';
  import { DEFAULT_NEST_BUDGET_MS } from '$lib/nesting/engine';

  const LAST_SIZE_TOOLTIP = 'At least one sheet size is required';

  let addButton = $state<HTMLButtonElement | undefined>();
  // Visually-hidden polite announcement for add/remove, so AT users hear list changes.
  let liveMessage = $state('');

  function removeLabel(width: number, height: number): string {
    return `Remove ${Math.round(width)} × ${Math.round(height)}`;
  }

  async function onAddSize() {
    // Index the new row will occupy (append), captured before the list grows.
    const newIndex = projectStore.sheetSizes.length;
    projectStore.addSheetSize();
    await tick();
    liveMessage = `Sheet size added, ${projectStore.sheetSizes.length} total`;
    document.getElementById(`sheet-${newIndex}-width-mm`)?.focus();
  }

  async function onRemoveSize(index: number) {
    // The lone row's remove control is aria-disabled (not native-disabled, so it stays
    // focusable); guard the no-op here since the click still fires.
    if (projectStore.sheetSizes.length <= 1) return;
    projectStore.removeSheetSize(index);
    await tick();
    liveMessage = `Sheet size removed, ${projectStore.sheetSizes.length} remaining`;
    // Focus the prior row's remove button, or the Add button when none precede.
    if (index > 0) document.getElementById(`remove-size-${index - 1}`)?.focus();
    else addButton?.focus();
  }

  function onMaxCountChange(index: number, e: Event) {
    const raw = (e.target as HTMLInputElement).value.trim();
    if (raw === '') {
      projectStore.setSheetMaxCount(index, undefined); // blank ⇒ unlimited
      return;
    }
    const n = parseInt(raw, 10);
    projectStore.setSheetMaxCount(index, isNaN(n) ? undefined : n);
  }

  function onToleranceChange(e: Event) {
    const tolerancePercent = parseFloat((e.target as HTMLInputElement).value);
    if (!isNaN(tolerancePercent)) projectStore.setMatchTolerance(tolerancePercent / 100);
  }

  function generations(): number {
    return projectStore.state.config.generations;
  }

  function onGenerationsChange(e: Event) {
    const generationCount = parseInt((e.target as HTMLInputElement).value, 10);
    if (!isNaN(generationCount) && generationCount > 0)
      projectStore.setGenerations(generationCount);
  }

  function timeBudgetSeconds(): number {
    return Math.round((projectStore.state.config.timeBudgetMs ?? DEFAULT_NEST_BUDGET_MS) / 1000);
  }

  function onTimeBudgetChange(e: Event) {
    const seconds = parseFloat((e.target as HTMLInputElement).value);
    if (!isNaN(seconds) && seconds > 0) projectStore.setTimeBudgetSeconds(seconds);
  }

  function maximizeDensity(): boolean {
    return projectStore.state.config.useNfpPlacement ?? false;
  }

  function onDensityChange(e: Event) {
    projectStore.setUseNfpPlacement((e.target as HTMLInputElement).checked);
  }

  function commonLineCutting(): boolean {
    return projectStore.state.config.commonLineCutting ?? false;
  }

  function onCommonLineChange(e: Event) {
    projectStore.setCommonLineCutting((e.target as HTMLInputElement).checked);
  }

  function tolerancePct(): string {
    return (projectStore.state.matchTolerance * 100).toFixed(1);
  }
</script>

<div class="material-settings">
  <h3>Material</h3>
  <p class="hint">Enter dimensions in millimeters or inches — both update together.</p>
  <div class="fields">
    <div class="sheet-sizes">
      <span id="last-size-reason" class="sr-only">{LAST_SIZE_TOOLTIP}</span>
      {#each projectStore.sheetSizes as size, i (i)}
        <div class="sheet-size-row" role="group" aria-label={`Sheet size ${i + 1}`}>
          <DimensionInput
            id={`sheet-${i}-width`}
            label="Width"
            tooltip="Width of this material sheet size."
            valueMM={size.width}
            minMM={0.1}
            onChange={(mm) => projectStore.updateSheetSize(i, { width: mm })}
          />
          <DimensionInput
            id={`sheet-${i}-height`}
            label="Height"
            tooltip="Height of this material sheet size."
            valueMM={size.height}
            minMM={0.1}
            onChange={(mm) => projectStore.updateSheetSize(i, { height: mm })}
          />
          <div
            class="field max-sheets"
            use:tooltip={'Maximum number of sheets of this size the nester may use. Leave blank for unlimited.'}
          >
            <label for={`max-sheets-${i}`}>Max sheets</label>
            <input
              id={`max-sheets-${i}`}
              type="number"
              min="1"
              step="1"
              placeholder="unlimited"
              value={size.maxCount ?? ''}
              onchange={(e) => onMaxCountChange(i, e)}
            />
          </div>
          <button
            type="button"
            id={`remove-size-${i}`}
            class="remove-size"
            class:is-disabled={projectStore.sheetSizes.length === 1}
            aria-label={removeLabel(size.width, size.height)}
            aria-disabled={projectStore.sheetSizes.length === 1 ? 'true' : undefined}
            aria-describedby={projectStore.sheetSizes.length === 1 ? 'last-size-reason' : undefined}
            title={projectStore.sheetSizes.length === 1 ? LAST_SIZE_TOOLTIP : undefined}
            use:tooltip={projectStore.sheetSizes.length === 1
              ? LAST_SIZE_TOOLTIP
              : 'Remove this sheet size'}
            onclick={() => onRemoveSize(i)}
          >
            ×
          </button>
        </div>
      {/each}
      <button type="button" class="add-size" bind:this={addButton} onclick={onAddSize}>
        + Add size
      </button>
      <p class="hint max-sheets-hint">Blank “Max sheets” means unlimited supply of that size.</p>
      <p class="sr-only" role="status" aria-live="polite">{liveMessage}</p>
    </div>
    <DimensionInput
      id="kerf"
      label="Kerf"
      tooltip="Cut-width compensation — spacing added around every part for the laser beam's material removal, so cut edges don't overlap."
      valueMM={projectStore.state.config.kerf}
      minMM={0}
      mmStep={0.1}
      inStep={0.005}
      mmDecimals={1}
      inDecimals={3}
      onChange={(mm) => projectStore.setKerf(mm)}
    />
  </div>

  <h3 class="section-heading">Nesting</h3>
  <div class="fields">
    <div
      class="field"
      use:tooltip={'How many genetic-algorithm iterations to run per sheet. More generations can find tighter layouts but take longer.'}
    >
      <label for="generations">Generations</label>
      <input
        id="generations"
        type="number"
        min="1"
        max="1000"
        step="10"
        value={generations()}
        onchange={onGenerationsChange}
      />
    </div>
    <div
      class="field"
      use:tooltip={'Maximum time to spend nesting before returning the best layout found so far.'}
    >
      <label for="time-budget">Time limit (s)</label>
      <input
        id="time-budget"
        type="number"
        min="1"
        max="600"
        step="5"
        value={timeBudgetSeconds()}
        onchange={onTimeBudgetChange}
      />
    </div>
    <div
      class="field"
      use:tooltip={'Search for interlocking placements for denser packing (slower). Turn off for faster nesting of simple layouts.'}
    >
      <label for="max-density">Maximize density</label>
      <input
        id="max-density"
        type="checkbox"
        checked={maximizeDensity()}
        onchange={onDensityChange}
      />
    </div>
    <div class="tolerance-hint">
      Maximize density searches for interlocking placements — denser, but slower. Turn it off for
      simple layouts to nest much faster. Either way, nesting stops at the time limit (or when you
      press Stop) and keeps the best layout found.
    </div>
    <div
      class="field"
      use:tooltip={'Let adjacent parts share a single cut line — abutting parts touch (no kerf gap) and the shared edge is cut once, saving cut time and material.'}
    >
      <label for="common-line">Common-line cutting</label>
      <input
        id="common-line"
        type="checkbox"
        checked={commonLineCutting()}
        onchange={onCommonLineChange}
      />
    </div>
    <div class="tolerance-hint">
      Common-line cutting places parts edge-to-edge so shared boundaries are cut once — less cut
      time and material, at the cost of no spacing between parts.
    </div>
  </div>

  <h3 class="section-heading">Shape Matching</h3>
  <div class="fields">
    <div
      class="field"
      use:tooltip={'How closely two parts must match to be treated as identical and grouped into one entry with a quantity count. Higher groups more aggressively; lower keeps near-matches separate.'}
    >
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
    font-size: 0.95rem;
    color: var(--text);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .section-heading {
    margin-top: 1rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
  }

  .hint {
    margin: 0 0 0.6rem 0;
    font-size: 0.75rem;
    color: var(--muted);
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
    color: var(--text-dim);
    min-width: 120px;
  }

  input[type='number'] {
    width: 5rem;
    padding: 0.3rem 0.4rem;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    font-size: 0.85rem;
    text-align: right;
    color: var(--text);
    background: var(--surface-inset);
  }

  input[type='number']:focus {
    outline: none;
    border-color: var(--brand);
    box-shadow: var(--focus-ring);
  }

  input[type='range'] {
    flex: 1;
    max-width: 120px;
    accent-color: var(--brand);
  }

  input[type='checkbox'] {
    accent-color: var(--brand);
  }

  .tolerance-hint {
    font-size: 0.75rem;
    color: var(--muted);
    padding-left: 120px;
  }

  .sheet-sizes {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .sheet-size-row {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.5rem 0.5rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    position: relative;
  }

  .max-sheets label {
    min-width: 120px;
  }

  .max-sheets input {
    width: 5rem;
    padding: 0.3rem 0.4rem;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    font-size: 0.85rem;
    text-align: right;
    color: var(--text);
    background: var(--surface-inset);
  }

  .max-sheets input:focus {
    outline: none;
    border-color: var(--brand);
    box-shadow: var(--focus-ring);
  }

  .remove-size {
    position: absolute;
    top: 0.35rem;
    right: 0.4rem;
    width: 1.5rem;
    height: 1.5rem;
    line-height: 1;
    font-size: 1.1rem;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    background: var(--surface-inset);
    color: var(--text-dim);
    cursor: pointer;
  }

  .remove-size.is-disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .remove-size:not(.is-disabled):hover {
    border-color: var(--brand);
    color: var(--text);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .add-size {
    align-self: flex-start;
    padding: 0.35rem 0.6rem;
    border: 1px dashed var(--border-strong);
    border-radius: 4px;
    background: transparent;
    color: var(--text-dim);
    font-size: 0.85rem;
    cursor: pointer;
  }

  .add-size:hover {
    border-color: var(--brand);
    color: var(--text);
  }

  .max-sheets-hint {
    margin: 0;
  }
</style>
