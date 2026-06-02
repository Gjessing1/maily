/**
 * Centralised environment configuration. Secrets (IMAP/SMTP credentials, JWT secret,
 * VAPID keys) are read here and never sent to the frontend — see ARCHITECTURE §5.
 */
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/**
 * Persistent data root. In production this is the mounted host volume /mnt/data/maily.
 * Locally it defaults to ./data so development needs no setup.
 */
const dataDir = resolve(optional('MAILY_DATA_DIR', './data'));
const dbPath = resolve(dataDir, optional('MAILY_DB_FILE', 'mail.sqlite'));
const attachmentsDir = resolve(dataDir, 'attachments');

// Ensure the data directory exists before SQLite tries to open the file.
mkdirSync(dirname(dbPath), { recursive: true });
mkdirSync(attachmentsDir, { recursive: true });

/** VAPID config for Web Push, or null when not configured (push disabled). */
function vapidConfig(): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    subject: optional('VAPID_SUBJECT', 'mailto:admin@localhost'),
  };
}

export const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  port: Number(optional('PORT', '3000')),
  dataDir,
  dbPath,
  attachmentsDir,
  /** Local SQLite cache window: how many days back the sync `since` filter reaches. */
  cacheWindowDays: Number(optional('MAILY_CACHE_WINDOW_DAYS', '365')),
  // Read lazily where needed so the app can boot in Phase 0 without them set:
  jwtSecret: () => required('JWT_SECRET'),
  masterPassword: () => required('MASTER_PASSWORD'),
  vapid: vapidConfig,
} as const;
