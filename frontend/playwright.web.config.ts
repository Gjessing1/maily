import { defineConfig, devices } from '@playwright/test';

/**
 * Browser-level checks that need a real engine rather than jsdom — currently the
 * sandboxed message frame, whose sandbox/srcdoc/CSP behaviour jsdom does not model.
 * Runs against the dev server's rendering-fixture page (see src/rendering-fixtures.tsx),
 * the same page the Android rendering suite drives on a device.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '*.web.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    ...devices['Pixel 7'],
    browserName: 'chromium',
    baseURL: 'http://127.0.0.1:4174',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  webServer: {
    command: 'npm run dev -- --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174/rendering-fixtures/',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
