import { defineConfig } from '@playwright/test';

// Override the app under test (e.g. a prod build on :3005) with
// PW_BASE_URL; an already-running server there is reused as-is.
const BASE = process.env.PW_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: BASE,
    headless: true,
    trace: 'retain-on-failure',
  },
  // Live audits must use the explicitly chosen running app; never start a
  // second Next process that shares its build directory after a transient 500.
  webServer: process.env.SCATTER_LIVE_IMAGE_SEARCH === '1' ? undefined : {
    command: 'npm run dev',
    url: BASE,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
