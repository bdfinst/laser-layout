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
  <!-- Sticky header keeps the primary actions (Nest / Stop / Export) in view at
       all times, so the user never has to scroll to the bottom of the page to
       run the optimizer or download a result. -->
  <header class="banner">
    <div class="brand">
      <img class="logo" src={logoMark} alt="" width="40" height="40" />
      <div class="brand-text">
        <h1>Laser Layout</h1>
        <p class="subtitle">Nesting optimizer for laser cutting</p>
      </div>
    </div>
    <div class="header-actions">
      <ExportControls />
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
    </aside>

    <main class="preview">
      <LayoutPreview />
    </main>
  </div>
</div>

<style>
  :global(:root) {
    /* Laser-vector dark theme: deep near-black canvas, glowing cyan/neon strokes
       that evoke vector art traced by a cutting head. */
    --bg: #070b11;
    --bg-2: #050810;
    --grid-line: rgba(46, 230, 214, 0.045);
    --surface: #0f1722;
    --surface-2: #0b121b;
    --surface-inset: #0a0f17;
    --border: #1d2a39;
    --border-strong: #2b3d53;

    --text: #e7f1f8;
    --text-dim: #a6bacb;
    --muted: #66798d;

    --brand: #2ee6d6; /* laser cyan */
    --brand-dim: #1ba99d;
    --laser: #39ff7a; /* neon cut-line green */
    --accent: #ff3b6b; /* hot beam pink/red */
    --success: #39ff7a;
    --warn: #ffb454;

    --glow-brand: 0 0 5px rgba(46, 230, 214, 0.55), 0 0 14px rgba(46, 230, 214, 0.22);
    --glow-accent: 0 0 5px rgba(255, 59, 107, 0.6), 0 0 14px rgba(255, 59, 107, 0.25);
    --glow-laser: 0 0 5px rgba(57, 255, 122, 0.6), 0 0 14px rgba(57, 255, 122, 0.25);

    --radius: 10px;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.5), 0 2px 10px rgba(0, 0, 0, 0.35);
    --shadow-lg: 0 10px 34px rgba(0, 0, 0, 0.55);

    color-scheme: dark;
  }

  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: var(--text);
    background-color: var(--bg);
    /* Faint laser-CAD grid drawn over a radial vignette. */
    background-image:
      linear-gradient(var(--grid-line) 1px, transparent 1px),
      linear-gradient(90deg, var(--grid-line) 1px, transparent 1px),
      radial-gradient(1200px 600px at 70% -10%, rgba(46, 230, 214, 0.06), transparent 60%),
      linear-gradient(160deg, var(--bg) 0%, var(--bg-2) 100%);
    background-size:
      28px 28px,
      28px 28px,
      100% 100%,
      100% 100%;
    background-attachment: fixed;
  }

  .app {
    max-width: 1280px;
    margin: 0 auto;
    padding: 0 1rem 3rem;
  }

  .banner {
    position: sticky;
    top: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    padding: 0.85rem 1.25rem;
    margin: 0 -1rem 1.5rem;
    background: rgba(11, 17, 26, 0.85);
    backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--border-strong);
    box-shadow: var(--shadow);
  }

  /* Laser-themed accent strip along the bottom edge of the sticky header. */
  .banner::after {
    content: '';
    position: absolute;
    inset: auto 0 0 0;
    height: 2px;
    background: linear-gradient(
      90deg,
      transparent,
      var(--brand) 30%,
      var(--accent) 70%,
      transparent
    );
    opacity: 0.7;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    min-width: 0;
  }

  .logo {
    flex-shrink: 0;
    filter: drop-shadow(0 0 6px rgba(46, 230, 214, 0.5));
  }

  .brand-text {
    min-width: 0;
  }

  h1 {
    margin: 0;
    font-size: 1.4rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text);
    text-shadow: 0 0 18px rgba(46, 230, 214, 0.25);
  }

  .subtitle {
    margin: 0.1rem 0 0 0;
    font-size: 0.8rem;
    color: var(--muted);
  }

  .header-actions {
    display: flex;
    align-items: center;
  }

  .layout {
    display: grid;
    grid-template-columns: 340px 1fr;
    gap: 1.5rem;
    align-items: start;
  }

  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    /* Let the sidebar scroll independently within a tall viewport so the
       preview stays put while the part list grows. */
    position: sticky;
    top: 5.5rem;
    max-height: calc(100vh - 6.5rem);
    overflow-y: auto;
    padding-right: 0.25rem;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.1rem 1.2rem;
    box-shadow: var(--shadow);
    transition:
      box-shadow 0.2s,
      border-color 0.2s;
  }

  .card:hover {
    border-color: var(--border-strong);
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

  @media (max-width: 860px) {
    .layout {
      grid-template-columns: 1fr;
    }

    .sidebar {
      position: static;
      max-height: none;
      overflow: visible;
    }
  }
</style>
