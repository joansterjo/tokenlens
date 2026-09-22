import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
export default defineConfig({ test: { projects: [
  { test: { name: 'node', include: ['test/unit/**/*.test.ts'], environment: 'node' } },
  { test: { name: 'browser', include: ['test/browser/**/*.test.ts'], browser: {
    enabled: true, provider: playwright({ launchOptions: {
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    } }), headless: true, instances: [{ browser: 'chromium' }],
  } } },
] } });
