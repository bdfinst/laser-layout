<script lang="ts">
  import { projectStore, toDisplayUnits } from '$lib/stores/project.svelte';
  import { toSVGPathD } from '$lib/geometry/polygon';
  import { partThumbnail } from '$lib/geometry/thumbnail';
  import { tooltip } from '$lib/actions/tooltip';

  // Compute each part's thumbnail geometry once per parts-change, not per render.
  const thumbnails = $derived(
    new Map(projectStore.state.parts.map((p) => [p.id, partThumbnail(p)])),
  );

  function onQuantityChange(partId: string, e: Event) {
    const input = e.target as HTMLInputElement;
    projectStore.setQuantity(partId, parseInt(input.value) || 0);
  }

  function onLockChange(partId: string, e: Event) {
    const input = e.target as HTMLInputElement;
    projectStore.setLockOrientation(partId, input.checked);
  }

  function onPriorityChange(partId: string, e: Event) {
    const select = e.target as HTMLSelectElement;
    projectStore.setPriority(partId, select.value === 'optional' ? 'optional' : 'required');
  }

  function onGrainChange(partId: string, e: Event) {
    const input = e.target as HTMLInputElement;
    projectStore.setGrainConstraint(partId, input.checked);
  }

  function fmtMm(mm: number): string {
    return mm.toFixed(1);
  }

  function fmtIn(mm: number): string {
    return toDisplayUnits(mm, 'in').toFixed(2);
  }

  function totalParts(): number {
    let total = 0;
    for (const qty of projectStore.state.quantities.values()) {
      total += qty;
    }
    return total;
  }

  const THUMB_SIZE = 48;
</script>

{#if projectStore.state.parts.length > 0}
  <div class="part-list">
    <h3>Parts ({totalParts()} total)</h3>
    <div class="parts">
      {#each projectStore.state.parts as part (part.id)}
        {@const thumb = thumbnails.get(part.id)!}
        <div class="part-row">
          <div class="thumb">
            <svg
              width={THUMB_SIZE}
              height={THUMB_SIZE}
              viewBox={thumb.viewBox}
              xmlns="http://www.w3.org/2000/svg"
            >
              {#each part.polygons as poly, polyIdx (polyIdx)}
                <path
                  d={toSVGPathD(poly)}
                  fill="#2ee6d61f"
                  stroke="#2ee6d6"
                  stroke-width={thumb.strokeWidth}
                />
              {/each}
            </svg>
          </div>
          <div class="info">
            <span class="name" title={part.name}>{part.name}</span>
            <span class="size">{fmtMm(thumb.width)} × {fmtMm(thumb.height)} mm</span>
            <span class="size alt">{fmtIn(thumb.width)} × {fmtIn(thumb.height)} in</span>
          </div>
          <div class="qty" use:tooltip={'Number of copies of this part to nest.'}>
            <input
              type="number"
              min="0"
              max="100"
              value={projectStore.state.quantities.get(part.id) ?? 1}
              onchange={(e) => onQuantityChange(part.id, e)}
            />
          </div>
          <div
            class="priority"
            use:tooltip={'Required parts always get a sheet. Optional parts fill in where they fit and are dropped instead of opening a new sheet.'}
          >
            <label class="sr-only" for={`priority-${part.id}`}>Priority for {part.name}</label>
            <select
              id={`priority-${part.id}`}
              value={part.priority ?? 'required'}
              onchange={(e) => onPriorityChange(part.id, e)}
            >
              <option value="required">Required</option>
              <option value="optional">Optional</option>
            </select>
          </div>
          <div
            class="grain"
            use:tooltip={'Directional material: only allow 0°/180° rotation so the grain stays aligned.'}
          >
            <input
              type="checkbox"
              id={`grain-${part.id}`}
              aria-describedby="grain-hint"
              checked={part.grainConstraint ?? false}
              onchange={(e) => onGrainChange(part.id, e)}
            />
            <label for={`grain-${part.id}`}>
              Grain
              <span class="sr-only">lock 0°/180° for {part.name}</span>
            </label>
          </div>
          <div
            class="lock-orientation"
            use:tooltip={'Never mirror this part during nesting; rotation and placement are still optimized.'}
          >
            <input
              type="checkbox"
              id={`lock-${part.id}`}
              aria-describedby="lock-orientation-hint"
              checked={part.lockOrientation ?? false}
              onchange={(e) => onLockChange(part.id, e)}
            />
            <label for={`lock-${part.id}`}>
              Lock orientation
              <span class="sr-only">for {part.name}</span>
            </label>
          </div>
        </div>
      {/each}
    </div>
    <p id="lock-orientation-hint" class="hint">
      Locked parts are never mirrored during nesting; rotation and placement are still optimized.
    </p>
    <p id="grain-hint" class="hint">
      Optional parts fill in where they fit and are dropped instead of opening a new sheet. Grain
      locks a part to 0°/180° rotation for directional material.
    </p>
  </div>
{/if}

<style>
  .part-list {
    margin-top: 1rem;
  }

  h3 {
    margin: 0 0 0.5rem 0;
    font-size: 0.95rem;
    color: var(--text);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .parts {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .part-row {
    display: flex;
    align-items: center;
    /* The sidebar is narrow (340px) and each row now carries several controls
       (qty, priority, grain, lock). Wrap so the controls flow onto a second line
       instead of squeezing .info to zero width and clipping the size text. */
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-2);
  }

  .part-row:hover {
    background: var(--surface-inset);
    border-color: var(--border-strong);
  }

  .thumb {
    flex-shrink: 0;
    background: var(--surface-inset);
    border-radius: 4px;
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .info {
    /* Keep a width floor so the dual mm/in size text always has room to render;
       without it the row's fixed controls can collapse .info to zero width. */
    flex: 1 1 8rem;
    min-width: 8rem;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .name {
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .size {
    color: var(--text-dim);
    font-family: monospace;
    font-size: 0.75rem;
  }

  .size.alt {
    color: var(--muted);
  }

  .qty input {
    width: 3.5rem;
    padding: 0.2rem 0.3rem;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    text-align: center;
    font-size: 0.85rem;
    color: var(--text);
    background: var(--surface-inset);
  }

  .priority {
    flex-shrink: 0;
  }

  .priority select {
    padding: 0.2rem 0.3rem;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    font-size: 0.8rem;
    color: var(--text);
    background: var(--surface-inset);
  }

  input[type='checkbox'] {
    accent-color: var(--brand);
  }

  .grain,
  .lock-orientation {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .grain label {
    font-size: 0.75rem;
    color: var(--text-dim);
    white-space: nowrap;
    cursor: pointer;
  }

  .lock-orientation label {
    font-size: 0.75rem;
    color: var(--text-dim);
    white-space: nowrap;
    cursor: pointer;
  }

  .hint {
    margin: 0.4rem 0 0 0;
    font-size: 0.72rem;
    color: var(--muted);
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
</style>
