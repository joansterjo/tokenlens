import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test', testMatch: ['e2e/**/*.spec.ts', 'perf/**/*.spec.ts', 'spikes/**/*.spec.ts'],
  timeout: 60000, expect: { timeout: 10000 }, workers: 1,
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: { ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) },
  },
  webServer: [
    { command: 'node scripts/fixture-server.mjs 4173', url: 'http://127.0.0.1:4173', reuseExistingServer: true },
    { command: 'node scripts/fixture-server.mjs 4174', url: 'http://127.0.0.1:4174', reuseExistingServer: true },
    { command: 'pnpm exec vite --config vite.tools.config.ts', url: 'http://127.0.0.1:4175/test/fixtures/01-basic.html', reuseExistingServer: true },
  ],
});
