<script lang="ts">
  import FileUpload from '$lib/components/FileUpload.svelte';
  import PartList from '$lib/components/PartList.svelte';
  import MaterialSettings from '$lib/components/MaterialSettings.svelte';
  import LayoutPreview from '$lib/components/LayoutPreview.svelte';
  import ExportControls from '$lib/components/ExportControls.svelte';
  import logoMark from '$lib/assets/favicon.svg';
</script>

<svelte:head>
  <title>Laser Layout — Nesting Optimizer</title>
</svelte:head>

<div class="app">
  <header>
    <img class="logo" src={logoMark} alt="" width="40" height="40" />
    <div class="brand">
      <h1>Laser Layout</h1>
      <p class="subtitle">Nesting optimizer for laser cutting</p>
    </div>
  </header>

  <div class="layout">
    <aside class="sidebar">
      <FileUpload />
      <MaterialSettings />
      <PartList />
      <ExportControls />
    </aside>

    <main class="preview">
      <LayoutPreview />
    </main>
  </div>
</div>

<style>
  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f5f5f5;
    color: #333;
  }

  .app {
    max-width: 1200px;
    margin: 0 auto;
    padding: 1rem;
  }

  header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
  }

  .logo {
    flex-shrink: 0;
  }

  h1 {
    margin: 0;
    font-size: 1.5rem;
    color: #222;
  }

  .subtitle {
    margin: 0.25rem 0 0 0;
    font-size: 0.85rem;
    color: #888;
  }

  .layout {
    display: grid;
    grid-template-columns: 320px 1fr;
    gap: 1.5rem;
    align-items: start;
  }

  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .preview {
    min-height: 400px;
  }

  @media (max-width: 768px) {
    .layout {
      grid-template-columns: 1fr;
    }
  }
</style>
