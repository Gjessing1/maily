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
  },
});
