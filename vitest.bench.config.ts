import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

// Separate config for the nesting compaction benchmark so it stays out of the
// normal `npm test` run. Invoke with `npm run bench`.
export default defineConfig({
  plugins: [sveltekit()],
  test: {
    include: ['bench/**/*.bench.ts'],
    environment: 'jsdom', // lightburn parser uses DOMParser
    // The NFP feasible-region path (#26) is ~2.7x slower per nest, so the NFP-heavy rows push
    // the full benchmark to ~17 min; allow generous headroom (it is a manual dev tool, not CI).
    testTimeout: 1_500_000,
    // The benchmark prints a table to stdout; let console output through the default reporter.
    silent: false,
    disableConsoleIntercept: true,
  },
});
