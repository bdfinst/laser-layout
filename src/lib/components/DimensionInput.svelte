<script lang="ts">
  import { toDisplayUnits, fromDisplayUnits } from '$lib/stores/project.svelte';
  import { tooltip as tooltipAction } from '$lib/actions/tooltip';

  interface Props {
    /** Field label, e.g. "Width". */
    label: string;
    /** Current value in millimeters (the canonical unit). */
    valueMM: number;
    /** Called with the new value in millimeters whenever either input changes. */
    onChange: (mm: number) => void;
    /** Unique id base, used to wire the label to both inputs for a11y. */
    id: string;
    /** Hover tooltip describing what the field controls. */
    tooltip?: string;
    /** Minimum allowed value, in millimeters. */
    minMM?: number;
    mmStep?: number;
    inStep?: number;
    mmDecimals?: number;
    inDecimals?: number;
  }

  const {
    label,
    valueMM,
    onChange,
    id,
    tooltip,
    minMM = 0,
    mmStep = 1,
    inStep = 0.25,
    mmDecimals = 0,
    inDecimals = 2,
  }: Props = $props();

  // Both displays derive from the single canonical mm value, so editing one
  // immediately updates the other.
  const mmValue = $derived(valueMM.toFixed(mmDecimals));
  const inValue = $derived(toDisplayUnits(valueMM, 'in').toFixed(inDecimals));

  function commitMm(e: Event) {
    const val = parseFloat((e.target as HTMLInputElement).value);
    if (!isNaN(val) && val >= minMM) onChange(val);
  }

  function commitIn(e: Event) {
    const val = parseFloat((e.target as HTMLInputElement).value);
    if (isNaN(val)) return;
    const mm = fromDisplayUnits(val, 'in');
    if (mm >= minMM) onChange(mm);
  }
</script>

<div class="dim-field" use:tooltipAction={tooltip}>
  <span class="dim-label" id="{id}-label">{label}</span>
  <div class="dim-inputs">
    <span class="unit-input">
      <input
        id="{id}-mm"
        type="number"
        min={minMM}
        step={mmStep}
        value={mmValue}
        aria-labelledby="{id}-label {id}-mm-unit"
        onchange={commitMm}
      />
      <span class="unit" id="{id}-mm-unit">mm</span>
    </span>
    <span class="unit-input">
      <input
        id="{id}-in"
        type="number"
        min={toDisplayUnits(minMM, 'in')}
        step={inStep}
        value={inValue}
        aria-labelledby="{id}-label {id}-in-unit"
        onchange={commitIn}
      />
      <span class="unit" id="{id}-in-unit">in</span>
    </span>
  </div>
</div>

<style>
  .dim-field {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .dim-label {
    font-size: 0.85rem;
    color: var(--text-dim);
    min-width: 60px;
  }

  .dim-inputs {
    display: flex;
    gap: 0.4rem;
    flex: 1;
  }

  .unit-input {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    flex: 1;
  }

  .unit-input input {
    width: 100%;
    min-width: 0;
    padding: 0.3rem 0.4rem;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    font-size: 0.85rem;
    text-align: right;
    color: var(--text);
    background: var(--surface-inset);
  }

  .unit-input input:focus {
    outline: none;
    border-color: var(--brand);
    box-shadow: var(--focus-ring);
  }

  .unit {
    font-size: 0.75rem;
    color: var(--muted);
    min-width: 1.2rem;
  }
</style>
