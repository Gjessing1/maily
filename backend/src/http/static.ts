/**
 * Production static serving for the built PWA. In development the Vite dev server
 * proxies /api and /socket.io to the backend, so this is a no-op (the build dir
 * doesn't exist). In the Docker image the frontend's `dist/` is copied to
 * backend/public (see backend/Dockerfile), so the backend serves the same-origin
 * app shell, assets and service worker — keeping API, sockets and UI on one host.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

// Compiled to backend/dist/http/static.js, so the sibling build dir is ../../public.
const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, '../../public');

/**
 * Build an app-shell Content-Security-Policy from the **built** index.html.
 *
 * This is defence-in-depth for the app shell — distinct from the reading pane, which
 * renders untrusted email in its own sandboxed, null-origin iframe with a far stricter
 * `default-src 'none'` CSP (MailBody.tsx). Email HTML never touches the main DOM, so
 * this policy only has to keep the app's own shell honest.
 *
 * Inline scripts (the pre-paint theme bootstrap in index.html, plus whatever
 * vite-plugin-pwa injects for service-worker registration) are allowlisted by **hash**
 * rather than `'unsafe-inline'`. We hash the actual served bytes, so the policy stays
 * correct across builds without a brittle hard-coded digest. `frame-src 'self'` keeps
 * the reading pane's srcdoc iframe working (it inherits this origin under
 * allow-same-origin).
 *
 * **srcdoc inherits this CSP.** An `about:srcdoc` document (the reading-pane iframe)
 * inherits its embedder's policy *on top of* its own `<meta>` CSP, and the browser
 * enforces the intersection. So this policy is also the **ceiling** for email content:
 * remote `img`/`media`/`font` sources must be permitted here or the iframe's permissive
 * `img-src ... https: http:` is overruled and remote images silently fail to load. The
 * actual per-message gating (tracking-pixel blocking via `allowImages`) still happens in
 * the iframe's own stricter `<meta>` CSP — this just stops the shell from clamping it to
 * `'self' data: blob:`. The shell itself never references remote media, so widening these
 * here costs the shell nothing.
 */
function buildAppShellCsp(html: string): string {
  const hashes = new Set<string>();
  // Match inline <script>…</script> (no src=); hash the exact inner bytes the browser sees.
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const digest = createHash('sha256')
      .update(m[1] ?? '', 'utf8')
      .digest('base64');
    hashes.add(`'sha256-${digest}'`);
  }
  const scriptSrc = ["'self'", ...hashes].join(' ');
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    // img/media/font widened to remote schemes so the inherited srcdoc iframe can load
    // email images (see the ceiling note above); the shell loads none of these remotely.
    "img-src 'self' data: blob: https: http:",
    "media-src 'self' data: https: http:",
    "font-src 'self' data: https: http:",
    "connect-src 'self'",
    "frame-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export async function staticSite(app: FastifyInstance): Promise<void> {
  const root = resolve(process.env.MAILY_WEB_ROOT ?? defaultRoot);

  const indexPath = join(root, 'index.html');
  if (!existsSync(indexPath)) {
    app.log.info(`static site disabled — no build at ${root} (dev uses the Vite proxy)`);
    return;
  }

  // Derive the CSP once from the built shell. Prod-only by construction (this whole
  // module no-ops in dev, where Vite serves the app and needs inline/WS for HMR).
  const appShellCsp = buildAppShellCsp(readFileSync(indexPath, 'utf8'));

  // Apply the app-shell CSP to HTML responses only (the shell + SPA fallback), never
  // to API JSON. fastifyStatic and reply.sendFile both set text/html for index.html.
  app.addHook('onSend', async (_req, reply, payload) => {
    const ct = reply.getHeader('content-type');
    if (typeof ct === 'string' && ct.includes('text/html')) {
      reply.header('Content-Security-Policy', appShellCsp);
    }
    return payload;
  });

  // wildcard:false serves real files and lets everything else fall through to the
  // not-found handler, which we use for the SPA fallback below.
  //
  // Cache policy (the reason CSS changes used to need a "clear site data"): Vite
  // fingerprints everything under /assets/ with a content hash, so those bytes are
  // immutable and can be cached forever — a changed file ships under a new name.
  // Everything else (index.html, sw.js, the web manifest, icons) keeps its name
  // across deploys, so it MUST revalidate ('no-cache' = cache but always check the
  // ETag). The service worker only discovers a new build when the browser re-fetches
  // sw.js from the network; an HTTP-cached sw.js silently pins the stale precached
  // shell — including the old CSS hash — until the cache is cleared by hand.
  await app.register(fastifyStatic, {
    root,
    wildcard: false,
    cacheControl: false,
    setHeaders(res, filePath) {
      const cache = /[\\/]assets[\\/]/.test(filePath)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache';
      res.setHeader('Cache-Control', cache);
    },
  });

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
