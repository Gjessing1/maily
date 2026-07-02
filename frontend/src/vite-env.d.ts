/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** Optional explicit API origin; empty means same-origin (dev uses the Vite proxy). */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Short git SHA baked in at build time (vite `define`); 'dev' outside CI. */
declare const __BUILD_ID__: string;
/** ISO timestamp of when the bundle was built (vite `define`). */
declare const __BUILT_AT__: string;
