import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

// Separate config for the nesting compaction benchmark so it stays out of the
// normal `npm test` run. Invoke with `npm run bench`.
export default defineConfig({
  plugins: [sveltekit()],
  test: {
    include: ['bench/**/*.bench.ts'],
    environment: 'jsdom', // lightburn parser uses DOMParser
    testTimeout: 600000,
    // The benchmark prints a table to stdout; let console output through the default reporter.
    silent: false,
    disableConsoleIntercept: true,
  },
});
