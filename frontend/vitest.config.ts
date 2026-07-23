import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Standalone test config (not the app's vite.config.ts) so the PWA/Tailwind
// build plugins stay out of the unit-test pipeline. jsdom gives the component
// tests a DOM; setup.ts wires jest-dom matchers + a matchMedia stub.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Sits above setup.ts's asyncUtilTimeout (5s) so a test chaining a couple of slow
    // findBy* waits on the loaded N150 CI runner can't trip vitest's per-test timeout.
    testTimeout: 20000,
  },
});
