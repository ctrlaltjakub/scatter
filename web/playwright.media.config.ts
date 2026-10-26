import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/** Media controls must behave consistently in Chromium and Firefox/Zen. */
export default defineConfig(base, {
  testMatch: ['media-rendering-regressions.spec.ts'],
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
});
