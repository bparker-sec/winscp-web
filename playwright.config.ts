import { defineConfig, devices } from '@playwright/test';

// Browser smoke tests. The app depends on the host app's SDK bridge (OneDrive +
// TCP proxy) which isn't present in a plain browser, so these cover boot, render,
// and UI wiring — not live connections.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: 'http://localhost:5199',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev -- --port 5199 --strictPort',
    url: 'http://localhost:5199',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
