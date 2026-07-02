import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// Backend (Fastify + Socket.io) for the dev proxy. The built PWA talks to its
// own origin, so production serving sits the API behind the same host.
const BACKEND = process.env.VITE_BACKEND_URL ?? 'http://localhost:3000';

// Build identity baked into the bundle (Settings → About). GIT_SHA is a CI/Dockerfile
// build-arg; the bundled value is what proves which build the service worker is
// actually serving, so it must come from `define`, not a runtime fetch.
const BUILD_ID = (process.env.GIT_SHA ?? '').slice(0, 7) || 'dev';

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
    __BUILT_AT__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Custom service worker: Workbox precaching for the offline shell PLUS
      // our own Web Push / notificationclick handlers (ARCHITECTURE §3).
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: 'auto',
      registerType: 'autoUpdate',
      // mail.gjessing.io sits behind a cookie-based SSO (tinyauth via Caddy).
      // The browser fetches the manifest as an anonymous request, so without
      // this it gets a 401 from the auth gateway. `useCredentials` adds
      // crossorigin="use-credentials" to the injected manifest <link>, so the
      // browser sends the SSO cookie when fetching the manifest.
      useCredentials: true,
      manifest: {
        name: 'maily',
        short_name: 'maily',
        description: 'Single-user, mobile-first mail client.',
        theme_color: '#0b0b0f',
        background_color: '#0b0b0f',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
      devOptions: {
        enabled: true,
        type: 'module',
        navigateFallback: 'index.html',
      },
    }),
  ],
  server: {
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/socket.io': { target: BACKEND, ws: true, changeOrigin: true },
    },
  },
});
