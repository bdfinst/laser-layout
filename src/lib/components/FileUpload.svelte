<script lang="ts">
  import { parseSVG } from '$lib/parsers/svg-parser';
  import { parseLightBurnWithDiagnostics, summarizeSkipped } from '$lib/parsers/lightburn-parser';
  import { projectStore } from '$lib/stores/project.svelte';
  import { MAX_FILE_SIZE } from '$lib/parsers/constants';
  import { tooltip } from '$lib/actions/tooltip';

  let dragOver = $state(false);
  // Non-blocking inline import feedback (never a modal alert(), which would block
  // the page and any automation). `error` for failures/zero-import, `info` for a
  // successful-but-partial import that skipped some shapes.
  let importMessage = $state<{ text: string; kind: 'error' | 'info' } | null>(null);

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    importMessage = null;
    const file = files[0];
    if (file.size > MAX_FILE_SIZE) {
      importMessage = {
        text: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.`,
        kind: 'error',
      };
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const name = file.name;
      let parts;
      // Human-readable note about shapes the parser could not import, so a
      // zero/partial result explains itself instead of failing silently.
      let skipNote: string | null = null;

      try {
        if (name.endsWith('.svg')) {
          parts = parseSVG(text);
        } else if (name.endsWith('.lbrn') || name.endsWith('.lbrn2')) {
          const result = parseLightBurnWithDiagnostics(text);
          parts = result.parts;
          skipNote = summarizeSkipped(result.diagnostics);
        } else {
          importMessage = {
            text: 'Unsupported file format. Please use .svg, .lbrn, or .lbrn2',
            kind: 'error',
          };
          return;
        }
      } catch {
        // A malformed/crafted file should surface a friendly error, not an unhandled throw.
        importMessage = {
          text: 'Could not read this file — it may be malformed or corrupted.',
          kind: 'error',
        };
        return;
      }

      if (parts.length === 0) {
        importMessage = {
          text: skipNote ? `No parts imported. ${skipNote}.` : 'No parts found in file.',
          kind: 'error',
        };
        return;
      }

      if (skipNote) {
        importMessage = {
          text: `Imported ${parts.length} part${parts.length === 1 ? '' : 's'}. ${skipNote}.`,
          kind: 'info',
        };
      }

      projectStore.setParts(parts, name);
    };
    reader.readAsText(file);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    handleFiles(e.dataTransfer?.files ?? null);
  }

  function onDragOver(e: DragEvent) {
    e.preventDefault();
    dragOver = true;
  }

  function onDragLeave() {
    dragOver = false;
  }

  function onChange(e: Event) {
    const input = e.target as HTMLInputElement;
    handleFiles(input.files);
  }

  // The drop-zone is a focusable role="button"; mirror native button keys so
  // keyboard users can open the file dialog with Enter or Space.
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      (document.getElementById('file-input') as HTMLInputElement | null)?.click();
    }
  }
</script>

<div
  class="upload-zone"
  class:drag-over={dragOver}
  use:tooltip={'Upload an SVG, .lbrn, or .lbrn2 file (max 10 MB) — drop it here or click to browse.'}
  ondrop={onDrop}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  onkeydown={onKeyDown}
  role="button"
  tabindex="0"
>
  <input type="file" accept=".svg,.lbrn,.lbrn2" onchange={onChange} id="file-input" hidden />
  <label for="file-input" class="upload-label">
    {#if projectStore.state.fileName}
      <span class="file-name">{projectStore.state.fileName}</span>
      <span class="hint">Click or drop to replace</span>
    {:else}
      <span class="icon">+</span>
      <span>Drop SVG or LightBurn file here</span>
      <span class="hint">or click to browse</span>
    {/if}
  </label>
</div>

{#if importMessage}
  <p
    class="import-message {importMessage.kind}"
    role={importMessage.kind === 'error' ? 'alert' : 'status'}
  >
    {importMessage.text}
  </p>
{/if}

<style>
  .upload-zone {
    border: 2px dashed var(--border-strong);
    border-radius: 8px;
    padding: 2rem;
    text-align: center;
    cursor: pointer;
    background: var(--surface-inset);
    transition:
      border-color 0.2s,
      background-color 0.2s,
      box-shadow 0.2s;
  }

  .upload-zone:hover,
  .drag-over {
    border-color: var(--brand);
    background-color: rgba(46, 230, 214, 0.06);
    box-shadow: var(--glow-brand);
  }

  .upload-label {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-size: 0.95rem;
    color: var(--text-dim);
  }

  .icon {
    font-size: 2rem;
    font-weight: bold;
    color: var(--brand);
    text-shadow: var(--glow-brand);
  }

  .import-message {
    margin: 0.5rem 0 0;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    font-size: 0.85rem;
    line-height: 1.3;
  }

  .import-message.error {
    color: var(--danger, #ff6b6b);
    background: rgba(255, 107, 107, 0.1);
  }

  .import-message.info {
    color: var(--text-dim);
    background: var(--surface-inset);
  }

  .hint {
    font-size: 0.8rem;
    color: var(--muted);
  }

  .file-name {
    font-weight: 600;
    color: var(--brand);
  }
</style>
