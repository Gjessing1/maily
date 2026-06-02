/**
 * Production static serving for the built PWA. In development the Vite dev server
 * proxies /api and /socket.io to the backend, so this is a no-op (the build dir
 * doesn't exist). In the Docker image the frontend's `dist/` is copied to
 * backend/public (see backend/Dockerfile), so the backend serves the same-origin
 * app shell, assets and service worker — keeping API, sockets and UI on one host.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

// Compiled to backend/dist/http/static.js, so the sibling build dir is ../../public.
const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, '../../public');

export async function staticSite(app: FastifyInstance): Promise<void> {
  const root = resolve(process.env.MAILY_WEB_ROOT ?? defaultRoot);

  if (!existsSync(join(root, 'index.html'))) {
    app.log.info(`static site disabled — no build at ${root} (dev uses the Vite proxy)`);
    return;
  }

  // wildcard:false serves real files and lets everything else fall through to the
  // not-found handler, which we use for the SPA fallback below.
  await app.register(fastifyStatic, { root, wildcard: false });

  // SPA fallback: client-side routes (e.g. /reader/:id) have no file on disk, so
  // serve the app shell for any unmatched GET that isn't an API or socket path.
  // Cold loads and hard refreshes on deep links land here; the service worker
  // covers subsequent offline navigations.
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/socket.io')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not found' });
  });

  app.log.info(`serving PWA from ${root}`);
}
