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

  let exportFormat = $state<'svg' | 'lightburn'>('svg');
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

    nest = runParallelNest(serializedInput, workerCount, factory, {
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
    });
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

    for (const sheet of result.sheets) {
      const suffix = result.sheets.length > 1 ? `-sheet-${sheet.sheetIndex + 1}` : '';
      if (exportFormat === 'svg') {
        const content = exportToSVG(sheet.placed, {
          sheetWidth: result.sheetWidth,
          sheetHeight: result.sheetHeight,
        });
        downloadFile(content, `nested-layout${suffix}.svg`, 'image/svg+xml');
      } else {
        const content = exportToLightBurn(sheet.placed, {
          sheetWidth: result.sheetWidth,
          sheetHeight: result.sheetHeight,
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
          <option value="svg">SVG</option>
          <option value="lightburn">LightBurn (.lbrn2)</option>
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

  .stop-btn {
    padding: 0.6rem 1.25rem;
    background: #e74c3c;
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
  }

  .stop-btn:hover {
    background: #c0392b;
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
