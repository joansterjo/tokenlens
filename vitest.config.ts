import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
export default defineConfig({ test: { projects: [
  { test: { name: 'node', include: ['test/unit/**/*.test.ts'], environment: 'node' } },
  { optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'] },
    // Browser capture checks include timing budgets. Avoid competing test tabs
    // and late JSX dependency optimization changing their measured workload.
    test: { name: 'browser', include: ['test/browser/**/*.test.ts'], fileParallelism: false, browser: {
    enabled: true, provider: playwright({ launchOptions: {
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    } }), headless: true, instances: [{ browser: 'chromium' }],
  } } },
] } });
