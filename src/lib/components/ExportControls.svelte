<script lang="ts">
  import { onDestroy } from 'svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import { exportToSVG } from '$lib/exporters/svg-exporter';
  import { exportToLightBurn } from '$lib/exporters/lightburn-exporter';
  import { tooltip } from '$lib/actions/tooltip';
  import {
    runParallelNest,
    desiredWorkerCount,
    type CoordinatorHandle,
    type WorkerLike,
  } from '$lib/nesting/nesting-coordinator';
  import { resolveTimeBudget } from '$lib/nesting/engine';

  let exportFormat = $state<'svg' | 'lightburn'>('lightburn');
  let nest: CoordinatorHandle | null = null;
  let currentRunId = 0;

  function teardownWorker() {
    if (nest) {
      nest.terminate();
      nest = null;
    }
  }

  function doNest() {
    const { parts, quantities, config } = projectStore.state;
    if (parts.length === 0) return;

    teardownWorker();
    projectStore.setNesting(true);

    const runId = ++currentRunId;
    const isCurrent = () => runId === currentRunId;

    // Parallel multi-start (#42): one worker per logical core, each running an independent
    // search; the coordinator keeps the global best. More starts per time budget, never worse
    // than serial. A single-core machine falls back to one worker (= serial behaviour).
    const workerCount = desiredWorkerCount(navigator.hardwareConcurrency);
    const factory = (): WorkerLike =>
      new Worker(new URL('../nesting/nesting-worker.ts', import.meta.url), {
        type: 'module',
      }) as unknown as WorkerLike;

    // Deep-clone to strip Svelte $state proxies (not structured-cloneable)
    const serializedInput = JSON.parse(
      JSON.stringify({
        parts,
        quantities: Object.fromEntries(quantities),
        config,
      }),
    );

    nest = runParallelNest(
      serializedInput,
      workerCount,
      factory,
      {
        onProgress: (currentSheet, generation, result) => {
          if (!isCurrent()) return;
          projectStore.updateResult(result, generation, currentSheet);
        },
        onDone: (result) => {
          if (!isCurrent()) return;
          projectStore.finishNesting(result);
          teardownWorker();
        },
        onError: (message) => {
          if (!isCurrent()) return;
          console.error('Nesting worker error:', message);
          projectStore.setNesting(false);
          teardownWorker();
        },
      },
      // Cap total wall-clock at the configured budget (+grace) so a straggler worker stuck in a
      // slow exact/NFP generation can't hang the run past the budget (#42).
      { timeBudgetMs: resolveTimeBudget(config) },
    );
  }

  function stopNest() {
    // Halt the workers and keep the best layout found so far (the latest progress result is
    // already in the store). Bumping the run id discards any in-flight worker message.
    currentRunId++;
    teardownWorker();
    const result = projectStore.state.result;
    if (result) {
      projectStore.finishNesting(result);
    } else {
      projectStore.setNesting(false);
    }
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

    // Match export edge-merging to how the layout was nested (#43).
    const commonLineCutting = projectStore.state.config.commonLineCutting ?? false;

    for (const sheet of result.sheets) {
      const suffix = result.sheets.length > 1 ? `-sheet-${sheet.sheetIndex + 1}` : '';
      if (exportFormat === 'svg') {
        const content = exportToSVG(sheet.placed, {
          sheetWidth: result.sheetWidth,
          sheetHeight: result.sheetHeight,
          commonLineCutting,
        });
        downloadFile(content, `nested-layout${suffix}.svg`, 'image/svg+xml');
      } else {
        const content = exportToLightBurn(sheet.placed, {
          sheetWidth: result.sheetWidth,
          sheetHeight: result.sheetHeight,
          commonLineCutting,
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
      use:tooltip={'Run the nesting optimizer to pack the parts onto material sheets.'}
      onclick={doNest}
      disabled={!canNest()}
    >
      {#if projectStore.state.isNesting}
        Nesting... Sheet {projectStore.state.currentSheet + 1}, Gen {projectStore.state.generation +
          1}
      {:else}
        Nest Parts
      {/if}
    </button>

    {#if projectStore.state.isNesting}
      <button
        class="stop-btn"
        use:tooltip={'Stop nesting now and keep the best layout found so far.'}
        onclick={stopNest}>Stop</button
      >
    {/if}

    {#if projectStore.state.result && !projectStore.state.isNesting}
      <div class="export-group">
        <select bind:value={exportFormat} use:tooltip={'Choose the export file format.'}>
          <option value="lightburn">LightBurn (.lbrn2)</option>
          <option value="svg">SVG</option>
        </select>
        <button
          class="export-btn"
          use:tooltip={'Download the nested layout — one file per sheet.'}
          onclick={doExport}
        >
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
  }

  .buttons {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  /* Glowing "laser-on" primary action. */
  .nest-btn {
    padding: 0.6rem 1.5rem;
    background: linear-gradient(180deg, rgba(46, 230, 214, 0.18), rgba(46, 230, 214, 0.06));
    color: var(--brand);
    border: 1px solid var(--brand-dim);
    border-radius: 7px;
    font-size: 0.95rem;
    font-weight: 600;
    letter-spacing: 0.01em;
    cursor: pointer;
    box-shadow: var(--glow-brand);
    transition:
      background 0.2s,
      box-shadow 0.2s,
      color 0.2s;
  }

  .nest-btn:hover:not(:disabled) {
    background: linear-gradient(180deg, rgba(46, 230, 214, 0.3), rgba(46, 230, 214, 0.12));
    color: #d8fffb;
    box-shadow:
      0 0 8px rgba(46, 230, 214, 0.75),
      0 0 20px rgba(46, 230, 214, 0.35);
  }

  .nest-btn:disabled {
    background: var(--surface-inset);
    color: var(--muted);
    border-color: var(--border);
    box-shadow: none;
    cursor: not-allowed;
  }

  .stop-btn {
    padding: 0.6rem 1.25rem;
    background: linear-gradient(180deg, rgba(255, 59, 107, 0.2), rgba(255, 59, 107, 0.07));
    color: var(--accent);
    border: 1px solid rgba(255, 59, 107, 0.55);
    border-radius: 7px;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    box-shadow: var(--glow-accent);
    transition:
      background 0.2s,
      box-shadow 0.2s;
  }

  .stop-btn:hover {
    background: linear-gradient(180deg, rgba(255, 59, 107, 0.32), rgba(255, 59, 107, 0.12));
    color: #ffd7e1;
  }

  .export-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  select {
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    font-size: 0.85rem;
    color: var(--text);
    background: var(--surface-inset);
  }

  .export-btn {
    padding: 0.55rem 1.1rem;
    background: linear-gradient(180deg, rgba(57, 255, 122, 0.18), rgba(57, 255, 122, 0.06));
    color: var(--laser);
    border: 1px solid rgba(57, 255, 122, 0.5);
    border-radius: 7px;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    box-shadow: var(--glow-laser);
    transition:
      background 0.2s,
      box-shadow 0.2s;
  }

  .export-btn:hover {
    background: linear-gradient(180deg, rgba(57, 255, 122, 0.3), rgba(57, 255, 122, 0.1));
    color: #d8ffe4;
  }
</style>
