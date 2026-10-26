import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/** Exercise the sandbox input boundary in both supported browser engines. */
export default defineConfig(base, {
  testMatch: ['interactive-input.spec.ts', 'interactive-recovery.spec.ts', 'interactive-visibility.spec.ts'],
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    {
      name: 'firefox',
      use: {
        browserName: 'firefox',
        // The automation default masks real window/iframe focus transitions.
        launchOptions: { firefoxUserPrefs: { 'focusmanager.testmode': false } },
      },
    },
  ],
});
