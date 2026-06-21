<script lang="ts">
  import { projectStore } from '$lib/stores/project.svelte';
  import DimensionInput from './DimensionInput.svelte';

  function onToleranceChange(e: Event) {
    const val = parseFloat((e.target as HTMLInputElement).value);
    if (!isNaN(val)) projectStore.setMatchTolerance(val / 100);
  }

  function generations(): number {
    return projectStore.state.config.generations;
  }

  function onGenerationsChange(e: Event) {
    const val = parseInt((e.target as HTMLInputElement).value, 10);
    if (!isNaN(val) && val > 0) projectStore.setGenerations(val);
  }

  function timeBudgetSeconds(): number {
    return Math.round((projectStore.state.config.timeBudgetMs ?? 60000) / 1000);
  }

  function onTimeBudgetChange(e: Event) {
    const val = parseFloat((e.target as HTMLInputElement).value);
    if (!isNaN(val) && val > 0) projectStore.setTimeBudgetSeconds(val);
  }

  function maximizeDensity(): boolean {
    return projectStore.state.config.useNfpPlacement ?? false;
  }

  function onDensityChange(e: Event) {
    projectStore.setUseNfpPlacement((e.target as HTMLInputElement).checked);
  }

  function tolerancePct(): string {
    return (projectStore.state.matchTolerance * 100).toFixed(1);
  }
</script>

<div class="material-settings">
  <h3>Material</h3>
  <p class="hint">Enter dimensions in millimeters or inches — both update together.</p>
  <div class="fields">
    <DimensionInput
      id="sheet-width"
      label="Width"
      tooltip="Width of the material sheet to nest parts onto."
      valueMM={projectStore.state.config.sheet.width}
      minMM={0.1}
      onChange={(mm) => projectStore.setSheetWidth(mm)}
    />
    <DimensionInput
      id="sheet-height"
      label="Height"
      tooltip="Height of the material sheet to nest parts onto."
      valueMM={projectStore.state.config.sheet.height}
      minMM={0.1}
      onChange={(mm) => projectStore.setSheetHeight(mm)}
    />
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
      title="How many genetic-algorithm iterations to run per sheet. More generations can find tighter layouts but take longer."
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
      title="Maximum time to spend nesting before returning the best layout found so far."
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
      title="Search for interlocking placements for denser packing (slower). Turn off for faster nesting of simple layouts."
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
  </div>

  <h3 class="section-heading">Shape Matching</h3>
  <div class="fields">
    <div
      class="field"
      title="How closely two parts must match to be treated as identical and grouped into one entry with a quantity count. Higher groups more aggressively; lower keeps near-matches separate."
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
    font-size: 1rem;
    color: #333;
  }

  .section-heading {
    margin-top: 1rem;
  }

  .hint {
    margin: 0 0 0.6rem 0;
    font-size: 0.75rem;
    color: #888;
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

  input[type='number'] {
    width: 5rem;
    padding: 0.3rem 0.4rem;
    border: 1px solid #ccc;
    border-radius: 4px;
    font-size: 0.85rem;
    text-align: right;
  }

  input[type='range'] {
    flex: 1;
    max-width: 120px;
  }

  .tolerance-hint {
    font-size: 0.75rem;
    color: #888;
    padding-left: 120px;
  }
</style>
