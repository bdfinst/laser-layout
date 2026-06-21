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
  <header class="banner">
    <img class="logo" src={logoMark} alt="" width="44" height="44" />
    <div class="brand">
      <h1>Laser Layout</h1>
      <p class="subtitle">Nesting optimizer for laser cutting</p>
    </div>
  </header>

  <div class="layout">
    <aside class="sidebar">
      <section class="card">
        <FileUpload />
      </section>
      <section class="card">
        <MaterialSettings />
      </section>
      <section class="card">
        <PartList />
      </section>
      <section class="card actions">
        <ExportControls />
      </section>
    </aside>

    <main class="preview">
      <LayoutPreview />
    </main>
  </div>
</div>

<style>
  :global(:root) {
    --brand: #4a90d9;
    --brand-dark: #357abd;
    --accent: #e74c3c;
    --surface: #ffffff;
    --border: #e2e8f0;
    --text: #1f2933;
    --muted: #64748b;
    --radius: 10px;
    --shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 3px rgba(15, 23, 42, 0.06);
    --shadow-lg: 0 6px 20px rgba(15, 23, 42, 0.08);
  }

  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: linear-gradient(160deg, #eef2f7 0%, #f7f9fc 100%);
    background-attachment: fixed;
    color: var(--text);
  }

  .app {
    max-width: 1200px;
    margin: 0 auto;
    padding: 1.5rem 1rem 3rem;
  }

  .banner {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.9rem;
    padding: 1.15rem 1.4rem;
    margin-bottom: 1.5rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    overflow: hidden;
  }

  /* Laser-themed accent strip down the left edge */
  .banner::before {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: 4px;
    background: linear-gradient(180deg, var(--brand) 0%, var(--accent) 100%);
  }

  .logo {
    flex-shrink: 0;
    filter: drop-shadow(0 1px 2px rgba(15, 23, 42, 0.12));
  }

  h1 {
    margin: 0;
    font-size: 1.6rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text);
  }

  .subtitle {
    margin: 0.2rem 0 0 0;
    font-size: 0.85rem;
    color: var(--muted);
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
    gap: 1rem;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.1rem 1.2rem;
    box-shadow: var(--shadow);
    transition: box-shadow 0.2s;
  }

  .card:hover {
    box-shadow: var(--shadow-lg);
  }

  /* Hide cards whose component renders nothing (e.g. empty part list) */
  .card:empty {
    display: none;
  }

  /* Neutralize the legacy top margin on each component's root element */
  .card > :global(*) {
    margin-top: 0;
  }

  .preview {
    min-height: 400px;
  }

  /* Elevate the layout preview to match the sidebar cards */
  .preview :global(.preview-container) {
    box-shadow: var(--shadow);
  }

  @media (max-width: 768px) {
    .layout {
      grid-template-columns: 1fr;
    }
  }
</style>
