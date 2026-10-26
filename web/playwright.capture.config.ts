import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig(base, {
  testMatch: ['screenshot-capture.spec.ts', 'interactive-verification.spec.ts', 'table-node.spec.ts'],
  workers: 1,
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox', launchOptions: { firefoxUserPrefs: { 'focusmanager.testmode': false } } } },
  ],
});
