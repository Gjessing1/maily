import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

// Playwright's Android driver shells out to adb. CI/developer shells normally
// export ANDROID_HOME, while the project host keeps its SDK at ~/android-sdk.
if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) {
  const candidates = [join(homedir(), 'android-sdk'), join(homedir(), 'Android', 'Sdk')];
  const sdk = candidates.find((candidate) => existsSync(join(candidate, 'platform-tools', 'adb')));
  if (sdk) process.env.ANDROID_HOME = sdk;
}

const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (sdk) {
  process.env.PATH = `${join(sdk, 'platform-tools')}:${process.env.PATH ?? ''}`;
}

export default defineConfig({
  testDir: './e2e',
  testMatch: 'rendering.android.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  webServer: {
    command: 'npm run dev -- --host 0.0.0.0 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173/rendering-fixtures/',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
