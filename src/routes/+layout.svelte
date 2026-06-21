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
    background: #1f2933;
    color: #fff;
    font-size: 0.75rem;
    line-height: 1.35;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(15, 23, 42, 0.18);
    pointer-events: none;
    white-space: normal;
  }
</style>
