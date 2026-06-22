<script lang="ts">
  import favicon from '$lib/assets/favicon.svg';

  const { children } = $props();
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
</svelte:head>

{@render children()}

<style>
  /* Instant, styled tooltips rendered into <body> by the `tooltip` action. */
  :global(.tooltip-popover) {
    position: fixed;
    z-index: 1000;
    max-width: 240px;
    padding: 0.4rem 0.6rem;
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border-strong);
    font-size: 0.75rem;
    line-height: 1.35;
    border-radius: 6px;
    box-shadow:
      0 4px 14px rgba(0, 0, 0, 0.55),
      0 0 0 1px rgba(46, 230, 214, 0.08);
    pointer-events: none;
    white-space: normal;
  }
</style>
