<script lang="ts">
  import { projectStore, formatDual } from '$lib/stores/project.svelte';
  import { getPlacedPolygons, toSVGPathD } from '$lib/geometry/polygon';

  // Neon palette tuned for glowing strokes on a dark sheet.
  const COLORS = [
    '#2ee6d6',
    '#39ff7a',
    '#ff3b6b',
    '#ffb454',
    '#b78cff',
    '#33b5ff',
    '#ff7ad9',
    '#9dff00',
  ];

  function getColor(index: number): string {
    return COLORS[index % COLORS.length];
  }

  function fmtDim(mm: number): string {
    return formatDual(mm);
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
          Sheet {projectStore.state.currentSheet + 1}, Gen {projectStore.state.generation + 1}
        </span>
      {/if}
      <span>Sheets: {result.sheets.length}</span>
      <span>Total placed: {result.totalPlaced}</span>
      {#if result.unplaced.length > 0}
        <span class="warning">Unplaced: {result.unplaced.length}</span>
      {/if}
    </div>

    <!-- Per-sheet layouts -->
    {#each result.sheets as sheet (sheet.sheetIndex)}
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
            <defs>
              <!-- Neon glow: blur a copy of the stroke and lay the crisp stroke on top. -->
              <filter id="laser-glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="0.6" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <!-- Faint CAD grid for the sheet bed. -->
              <pattern
                id="sheet-grid-{sheet.sheetIndex}"
                width="10"
                height="10"
                patternUnits="userSpaceOnUse"
              >
                <path d="M 10 0 L 0 0 0 10" fill="none" stroke="#2ee6d6" stroke-width="0.1" />
              </pattern>
            </defs>

            <rect
              x="0"
              y="0"
              width={result.sheetWidth}
              height={result.sheetHeight}
              fill="#0a0f17"
              stroke="#2b3d53"
              stroke-width="0.5"
            />
            <rect
              x="0"
              y="0"
              width={result.sheetWidth}
              height={result.sheetHeight}
              fill="url(#sheet-grid-{sheet.sheetIndex})"
            />

            {#if sheet.stripHeight > 0 && sheet.stripHeight < result.sheetHeight}
              <line
                x1="0"
                y1={sheet.stripHeight}
                x2={result.sheetWidth}
                y2={sheet.stripHeight}
                stroke="#ff3b6b"
                stroke-width="0.3"
                stroke-dasharray="3,3"
              />
            {/if}

            <g filter="url(#laser-glow)">
              {#each sheet.placed as pp, i (pp.part.id)}
                {@const polygons = getPlacedPolygons(pp)}
                {#each polygons as poly, polyIdx (polyIdx)}
                  <path
                    d={toSVGPathD(poly)}
                    fill="{getColor(i)}1f"
                    stroke={getColor(i)}
                    stroke-width="0.5"
                  />
                {/each}
              {/each}
            </g>
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
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--shadow);
    overflow: hidden;
  }

  .preview-container.empty {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 320px;
    color: var(--muted);
    font-size: 0.9rem;
  }

  .overall-stats {
    display: flex;
    gap: 1rem;
    padding: 0.6rem 1rem;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-dim);
    flex-wrap: wrap;
    align-items: center;
    transition: background 0.3s;
  }

  .overall-stats.running {
    background: rgba(46, 230, 214, 0.07);
    border-bottom-color: rgba(46, 230, 214, 0.3);
  }

  .gen-badge {
    background: rgba(46, 230, 214, 0.15);
    color: var(--brand);
    border: 1px solid var(--brand-dim);
    padding: 0.15rem 0.55rem;
    border-radius: 10px;
    font-size: 0.75rem;
    font-weight: 600;
    box-shadow: var(--glow-brand);
  }

  .warning {
    color: var(--accent);
  }

  .sheet-section {
    border-top: 1px solid var(--border);
  }

  .sheet-section:first-of-type {
    border-top: none;
  }

  .sheet-header {
    display: flex;
    gap: 1rem;
    padding: 0.4rem 1rem;
    background: var(--surface-inset);
    border-bottom: 1px solid var(--border);
    font-size: 0.8rem;
    color: var(--text-dim);
    align-items: center;
  }

  .sheet-title {
    font-weight: 600;
    color: var(--brand);
  }

  .sheet-stat {
    color: var(--muted);
  }

  .svg-wrapper {
    padding: 0.75rem;
    display: flex;
    justify-content: center;
    background:
      radial-gradient(600px 300px at 50% 0%, rgba(46, 230, 214, 0.05), transparent 70%),
      var(--surface);
  }

  .layout-svg {
    width: 100%;
    /* Preview scale: the portrait sheet is height-bound, so this cap sets the rendered size. */
    max-height: 690px;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    background: var(--surface-inset);
  }
</style>
