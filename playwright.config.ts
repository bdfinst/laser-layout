import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  // screenshot.spec.ts is a manual screenshot helper (hardcoded port, no
  // assertions) — skip it in CI so it doesn't fail the e2e job.
  testIgnore: process.env.CI ? ['**/screenshot.spec.ts'] : [],
  timeout: 60000,
  use: {
    baseURL: 'http://localhost:4173',
    headless: true,
  },
  webServer: {
    command: 'npm run build && npm run preview',
    port: 4173,
    reuseExistingServer: true,
    // Cold builds in CI take longer than a local dev machine.
    timeout: 120000,
  },
});
