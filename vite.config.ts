import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [sveltekit()],
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'jsdom',
    // Shape-aware nesting (true-shape kerf collision + concavity anchors) makes the
    // integration nests run for several seconds; the default 5s is too tight.
    testTimeout: 20000,
  },
});
