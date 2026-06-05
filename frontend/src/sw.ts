/// <reference lib="webworker" />
/**
 * Custom service worker (vite-plugin-pwa injectManifest strategy).
 *
 *  - Workbox precaches the built app shell so the PWA opens offline ( §6: the
 *    backend stays source of truth; this is only the shell + last-cached data ).
 *  - Web Push handlers wake the installed PWA on new mail while backgrounded
 *    (ARCHITECTURE §3). Payload shape mirrors backend/src/push/webpush.ts:
 *    { title, body, messageId }.
 */
import {
  precacheAndRoute,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

type PrecacheManifest = (string | { url: string; revision: string | null })[];
declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: PrecacheManifest };

// Drop precaches written by older deploys before installing the new manifest, so
// a redeploy can't keep serving a stale app shell (the cause of "must clear site
// data to log in" — see ROADMAP daily-use bugs).
cleanupOutdatedCaches();

// __WB_MANIFEST is injected at build time with the precache list.
precacheAndRoute(self.__WB_MANIFEST);

// SPA offline shell: serve index.html for navigations, but never for API/socket
// calls (those must hit the network and fail loudly when offline).
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/api\//, /^\/socket\.io\//],
  }),
);

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

interface MailPushPayload {
  title: string;
  body: string;
  messageId: string;
}

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload: MailPushPayload;
  try {
    payload = event.data.json() as MailPushPayload;
  } catch {
    payload = { title: 'maily', body: event.data.text(), messageId: '' };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || 'maily', {
      body: payload.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      tag: payload.messageId || undefined,
      data: { messageId: payload.messageId },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const messageId = (event.notification.data as { messageId?: string } | null)?.messageId;
  const url = messageId ? `/m/${messageId}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus an existing window and route it, else open a new one.
      for (const client of clients) {
        if ('focus' in client) {
          void client.focus();
          if ('navigate' in client) void client.navigate(url);
          return;
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
