/**
 * Firebase Cloud Messaging (HTTP v1) — the Android APK's background-notification
 * channel (ARCHITECTURE §3).
 *
 * Why a second channel at all: the APK is a Capacitor WebView shell around the same
 * web app, and Android System WebView exposes no Push API, so `pushManager` is absent
 * and the VAPID subscription the installed PWA holds is unreachable there. FCM is the
 * only transport that wakes a killed Android app. Both channels are driven off the
 * same `mail:new` signal (see webpush.ts), so a device gets exactly one notification
 * through whichever channel it registered on.
 *
 * No Firebase SDK: the admin SDK pulls in a large dependency tree for what is two HTTP
 * calls — a service-account JWT exchanged for an access token, then the send itself.
 * Disabled gracefully (every entry point a no-op) when no service account is configured.
 */
import { createSign } from 'node:crypto';
import { env } from '../env.js';
import { createLogger } from '../logger.js';
import { deleteDeviceToken, listDeviceTokens } from '../db/queries.js';

const log = createLogger('fcm');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
/** Renew the access token this early, so an in-flight send never races the expiry. */
const RENEW_MARGIN_MS = 60_000;
/** Google mints 1h tokens; cap the self-asserted JWT's own lifetime to the same. */
const ASSERTION_TTL_S = 3600;

let cached: { token: string; expiresAt: number } | null = null;

/** True when a Firebase service account is configured (i.e. the APK channel is live). */
export function fcmEnabled(): boolean {
  return env.fcm() !== null;
}

const base64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

/**
 * Mint an OAuth2 access token from the service account: a self-signed RS256 assertion
 * exchanged at Google's token endpoint. Cached until shortly before it expires, so the
 * steady state is one HTTP call per hour rather than one per notification.
 */
async function accessToken(): Promise<string | null> {
  const config = env.fcm();
  if (!config) return null;
  if (cached && cached.expiresAt > Date.now() + RENEW_MARGIN_MS) return cached.token;

  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: config.clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + ASSERTION_TTL_S,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  let assertion: string;
  try {
    assertion = `${header}.${claims}.${signer.sign(config.privateKey, 'base64url')}`;
  } catch (err) {
    log.warn(`service-account key rejected: ${(err as Error).message}`);
    return null;
  }

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!response.ok) {
    log.warn(`token exchange failed (${response.status}): ${await response.text()}`);
    return null;
  }
  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) return null;
  cached = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? ASSERTION_TTL_S) * 1000,
  };
  return cached.token;
}

export interface FcmPayload {
  title: string;
  body: string;
  /** Internal message UUID — the deep-link target the notification tap opens. */
  messageId: string;
}

/**
 * A token FCM tells us is dead. UNREGISTERED = the app was uninstalled or the token
 * rotated; INVALID_ARGUMENT on a send means the token itself is malformed. Both are
 * permanent, so the row is pruned rather than retried forever.
 */
function isDeadToken(status: number, body: string): boolean {
  if (status === 404) return true;
  return status === 400 && /INVALID_ARGUMENT|registration-token-not-registered/i.test(body);
}

/**
 * Fan a notification out to every registered device. Sends are independent (one HTTP
 * call per token — FCM v1 has no multicast endpoint) and failures are contained: a
 * dead token is pruned, anything else is logged. Never throws.
 */
export async function broadcastFcm(payload: FcmPayload): Promise<void> {
  const config = env.fcm();
  if (!config) return;
  const tokens = listDeviceTokens();
  if (tokens.length === 0) return;

  const auth = await accessToken();
  if (!auth) return;
  const url = `https://fcm.googleapis.com/v1/projects/${config.projectId}/messages:send`;

  await Promise.all(
    tokens.map(async (row) => {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              token: row.token,
              // `notification` lets the Firebase SDK post the notification itself while
              // the app is backgrounded or killed — no custom Service needed on Android.
              notification: { title: payload.title, body: payload.body },
              // `data` rides along to the tap handler, which deep-links to /m/:uuid.
              // With no `click_action` set, FCM opens the launcher activity and copies
              // these keys into its intent extras — which is exactly what MainActivity
              // reads (MailyNotificationLink). Naming an action here would need a
              // matching intent-filter, and a tap that resolves nothing does nothing.
              data: { messageId: payload.messageId },
              android: {
                priority: 'HIGH',
                notification: {
                  // One notification per message, matching the service worker's per-message
                  // `tag` on the Web Push path — a shared tag would make each new mail
                  // replace the last one in the shade.
                  tag: payload.messageId,
                },
              },
            },
          }),
        });
        if (response.ok) return;
        const text = await response.text();
        if (isDeadToken(response.status, text)) {
          deleteDeviceToken(row.token);
          log.info('pruned a device token FCM reports as gone');
          return;
        }
        log.warn(`FCM send failed (${response.status}): ${text}`);
      } catch (err) {
        log.warn(`FCM send failed: ${(err as Error).message}`);
      }
    }),
  );
}

/** Log the channel's state once at boot, mirroring initWebPush. */
export function initFcm(): boolean {
  const config = env.fcm();
  if (!config) {
    log.warn('no Firebase service account set — Android APK push disabled');
    return false;
  }
  log.info(`FCM ready for project ${config.projectId}`);
  return true;
}
