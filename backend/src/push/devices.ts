/**
 * Device credentials for self-hosted push (ARCHITECTURE §3).
 *
 * The Android APK cannot subscribe to Web Push — System WebView exposes no Push API —
 * so it opens a long-lived SSE connection to `/api/push/stream` from a foreground
 * service instead. That connection is made by the *native* shell, outside the WebView's
 * authenticated session, so it needs a credential of its own.
 *
 * Shape: the web layer (already authenticated) asks the server to mint a device secret,
 * hands it to the shell over the Capacitor bridge, and the shell presents it as a bearer
 * token from then on. The server keeps only the SHA-256 — the plaintext is returned once
 * and is unrecoverable afterwards, so a leaked DB backup does not leak a live credential.
 *
 * Why not reuse the master-password JWT: the deployment runs with `MAILY_DISABLE_AUTH`
 * behind an SSO gateway, where no JWT is ever minted. A device secret is also
 * individually revocable, which a shared 365-day token is not.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  deletePushDevice,
  pushDeviceByHash,
  savePushDevice,
  type PushDeviceRow,
} from '../db/queries.js';

/** 32 bytes of CSPRNG, base64url — 256 bits, unguessable, header-safe. */
const TOKEN_BYTES = 32;

export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Mint and store a device credential, returning the plaintext exactly once. */
export function issueDeviceToken(platform: string): string {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  savePushDevice(hashDeviceToken(token), platform);
  return token;
}

export function revokeDeviceToken(token: string): void {
  deletePushDevice(hashDeviceToken(token));
}

/**
 * The device a request's `Authorization: Bearer …` belongs to, or null.
 *
 * The hash lookup is an indexed equality on a value derived from the secret, so the
 * comparison SQLite does is already over a digest rather than the credential. The
 * explicit constant-time check afterwards guards the one case that leaves: a hash
 * collision would otherwise authenticate, and comparing the stored hash to the computed
 * one closes it without ever branching on how much of the secret matched.
 */
export function deviceForAuthHeader(header: string | undefined): PushDeviceRow | null {
  const token = /^Bearer (.+)$/i.exec(header?.trim() ?? '')?.[1];
  if (!token) return null;
  const hash = hashDeviceToken(token);
  const device = pushDeviceByHash(hash);
  if (!device) return null;
  const expected = Buffer.from(device.tokenHash);
  const got = Buffer.from(hash);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  return device;
}
