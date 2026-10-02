import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  globalTeardown: './tests/e2e/teardown.ts',
  fullyParallel: false,
  workers: 1, // flows share one throwaway database, never the user's household
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  use: { baseURL: 'http://127.0.0.1:15180', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: 'node --import tsx tests/e2e/server.ts', url: 'http://127.0.0.1:15180/api/meta', reuseExistingServer: false, timeout: 60_000 },
});
