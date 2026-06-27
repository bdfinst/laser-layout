import { sveltekit } from '@sveltejs/kit/vite';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // svelteTesting resolves Svelte's browser build and auto-cleans the DOM between
  // component tests (test-only; it no-ops outside vitest).
  plugins: [sveltekit(), svelteTesting()],
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'jsdom',
    // Shape-aware nesting (true-shape kerf collision + concavity anchors) makes the
    // integration nests run for several seconds; the default 5s is too tight.
    testTimeout: 20000,
  },
});
