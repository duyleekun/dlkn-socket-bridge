import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,          // auth flow can take ~10s
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    headless: false,         // run headed (Chrome visible)
    channel: 'chromium',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  // Do NOT start dev server automatically — user runs it manually
});
