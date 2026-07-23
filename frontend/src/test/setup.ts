import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// The CI runner is a slow N150 with several vitest workers competing for CPU, so an
// async render chain (open → fetch → setState → re-render) can take well over Testing
// Library's default 1s. That made timing-sensitive component tests flake in CI while
// passing locally. Give findBy*/waitFor generous slack so they reflect correctness,
// not runner load; vitest's testTimeout (see vitest.config.ts) sits above this ceiling.
configure({ asyncUtilTimeout: 5000 });

// jsdom doesn't implement matchMedia; the theme store (useSystemTheme) calls it
// at module load. Stub a non-matching (light) query so components can render.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

afterEach(() => cleanup());
