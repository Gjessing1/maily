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
/** Staging area for outbound attachments uploaded from the composer (pre-send). */
const uploadsDir = resolve(dataDir, 'uploads');
/** Canonical raw-RFC822 (.eml) archive (ROADMAP §3.7.E), partitioned per account/message. */
const sourceDir = resolve(dataDir, 'source');
/** WAL-safe SQLite snapshot dir — the off-host backup (backrest) grabs this, not the live DB. */
const backupDir = resolve(dataDir, 'backups');

// Ensure the data directory exists before SQLite tries to open the file.
mkdirSync(dirname(dbPath), { recursive: true });
mkdirSync(attachmentsDir, { recursive: true });
mkdirSync(uploadsDir, { recursive: true });
mkdirSync(sourceDir, { recursive: true });
mkdirSync(backupDir, { recursive: true });

/** Radicale CardDAV config for contacts sync, or null when not configured. */
function carddavConfig(): {
  url: string;
  user: string;
  password: string;
  refreshMs: number;
} | null {
  const url = process.env.CARDDAV_URL;
  const user = process.env.CARDDAV_USER;
  const password = process.env.CARDDAV_PASSWORD;
  if (!url || !user || !password) return null;
  return {
    url,
    user,
    password,
    refreshMs: Number(optional('CARDDAV_REFRESH_MS', String(6 * 60 * 60 * 1000))),
  };
}

/**
 * Radicale CalDAV config for the calendar integration (`calendar/`), or null when unset.
 * `url` seeds calendar **discovery** (`calendar/discover.ts`) — point it at the server
 * root, the principal, or one collection; discovery degrades to treating it as a single
 * calendar. Radicale serves CardDAV and CalDAV from the same principal with the same
 * secret, so each field **falls back to its `CARDDAV_*` twin** — a typical deployment
 * sets only the `CARDDAV_*` vars and gets calendars for free; set `CALDAV_*` only when
 * the calendar server (or account) differs.
 */
function caldavConfig(): { url: string; user: string; password: string } | null {
  const url = process.env.CALDAV_URL || process.env.CARDDAV_URL;
  const user = process.env.CALDAV_USER || process.env.CARDDAV_USER;
  const password = process.env.CALDAV_PASSWORD || process.env.CARDDAV_PASSWORD;
  if (!url || !user || !password) return null;
  return { url, user, password };
}

/**
 * Local Ollama runtime config for LLM enrichment (ROADMAP Phase 5), or null when unset.
 * LLM features are OFF unless `OLLAMA_URL` is explicitly set — privacy-first: a local-only
 * provider, no Claude/OpenAI/cloud path. When null no LLM enricher should register.
 * `model` defaults to `qwen2.5` (strong multilingual EN/NO, runs on modest CPU like the
 * target Intel N150). `timeoutMs` bounds every generation so a stuck model can't wedge the
 * single-flight queue.
 */
function ollamaConfig(): { url: string; model: string; timeoutMs: number } | null {
  const url = process.env.OLLAMA_URL;
  if (!url) return null;
  return {
    url: url.replace(/\/+$/, ''),
    model: optional('OLLAMA_MODEL', 'qwen2.5:7b'),
    timeoutMs: Number(optional('OLLAMA_TIMEOUT_MS', String(120_000))),
  };
}

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

/**
 * Disable maily's own login when the site is fronted by an external auth layer
 * (reverse-proxy SSO, mTLS, VPN). With this set the JWT guard is bypassed on every
 * HTTP route and the Socket.io handshake, and the PWA skips the login screen.
 * ONLY safe behind a trusted gateway — it removes all in-app authentication.
 */
const authDisabled = optional('MAILY_DISABLE_AUTH', 'false') === 'true';

export const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  port: Number(optional('PORT', '3000')),
  /** Short git SHA this image was built from (Dockerfile `GIT_SHA` build-arg; 'dev' locally). */
  buildId: optional('GIT_SHA', '').slice(0, 7) || 'dev',
  /** True when MAILY_DISABLE_AUTH=true — see note above. */
  disableAuth: authDisabled,
  dataDir,
  dbPath,
  attachmentsDir,
  uploadsDir,
  sourceDir,
  backupDir,
  /**
   * WAL-safe SQLite snapshot for off-host backup (ARCHITECTURE §1/§12). The live DB runs in
   * WAL mode, so an external backup tool copying `mail.sqlite` directly can capture a torn
   * state (committed pages still in the `-wal` sidecar). Instead we periodically write a
   * self-contained, consistent copy via the online-backup API and atomically rename it into
   * `backups/`; backrest backs up *that* file and handles versioning/retention.
   */
  dbBackup: {
    /** On by default; set `MAILY_DB_BACKUP=false` to disable (e.g. if backups are handled elsewhere). */
    enabled: optional('MAILY_DB_BACKUP', 'true') !== 'false',
    /** Snapshot cadence. Default 6h — backrest versions each overwrite, so this is just freshness. */
    intervalMs: Number(optional('MAILY_DB_BACKUP_MS', String(6 * 60 * 60 * 1000))),
    /** Rolling consistent snapshot file, atomically replaced each cycle. */
    path: resolve(backupDir, 'mail.sqlite.bak'),
  },
  /** Local SQLite cache window: how many days back the sync `since` filter reaches (0 = all). */
  cacheWindowDays: Number(optional('MAILY_CACHE_WINDOW_DAYS', '365')),
  /**
   * Per-day IMAP download byte budget (ROADMAP §3.7.E) — the governing throttle for
   * the full-source sweep, also drawn on by live capture so a burst of large new
   * mail can't breach it. Default ~2.4 GB, comfortably under Gmail's ~2.5 GB/day cap.
   */
  dailyDownloadBudgetBytes: Number(
    optional('MAILY_DAILY_DOWNLOAD_BUDGET_BYTES', String(2_400_000_000)),
  ),
  /**
   * Full-source sweep (ROADMAP §3.7.E): the throttled, budgeted historical backfill that
   * archives raw `.eml` for the backlog. On by default; set `MAILY_SOURCE_SWEEP=false` to
   * pause it (e.g. to spare the provider's daily IMAP download quota).
   */
  sourceSweepEnabled: optional('MAILY_SOURCE_SWEEP', 'true') !== 'false',
  /** How often each account's sweep driver wakes to do more backfill work. */
  sourceSweepIntervalMs: Number(optional('MAILY_SOURCE_SWEEP_MS', String(5 * 60_000))),
  /**
   * Enrichment-pipeline OPERATIONAL horizon (ARCHITECTURE §14): messages newer than
   * this run *all* enrichers incl. operational ones (Action Center / CalDAV side
   * effects); older mail is still processed for search/analytical, but operational
   * enrichers are suppressed so a deep backfill can't fire stale calendar events.
   * This gates side effects only — NOT whether old mail is processed.
   */
  pipelineHorizonDays: Number(optional('MAILY_PIPELINE_HORIZON_DAYS', '30')),
  /** Retry cap before a poison enrichment row is parked as dead-letter (status='dead'). */
  pipelineMaxAttempts: Number(optional('MAILY_PIPELINE_MAX_ATTEMPTS', '5')),
  /**
   * How many `llm`-cost enrichment rows a single worker nudge processes (ROADMAP Phase 5,
   * the N150 guard). Ollama generations are serialised single-flight and take seconds, so
   * we trickle a small batch per nudge — the cheap deterministic pipeline always drains
   * fully first, and the slow LLM backlog catches up over many nudges without monopolising
   * the worker against mail sync. Raise it to catch up faster at the cost of longer
   * sweep-blocking windows.
   */
  pipelineLlmBatch: Number(optional('MAILY_PIPELINE_LLM_BATCH', '6')),
  // Read lazily where needed so the app can boot in Phase 0 without them set:
  // When auth is disabled these are never used to gate access, so fall back to a
  // constant rather than forcing the operator to set them (see disableAuth above).
  jwtSecret: () =>
    authDisabled ? (process.env.JWT_SECRET ?? 'maily-auth-disabled') : required('JWT_SECRET'),
  masterPassword: () =>
    authDisabled ? (process.env.MASTER_PASSWORD ?? '') : required('MASTER_PASSWORD'),
  /**
   * Public base URL of the PWA (e.g. https://mail.example.com), used to build absolute
   * `/m/:uuid` deep links embedded in pushed calendar events. Empty → a relative path is
   * embedded instead (still recorded, just not directly clickable from an external client).
   */
  publicUrl: optional('MAILY_PUBLIC_URL', '').replace(/\/+$/, ''),
  vapid: vapidConfig,
  carddav: carddavConfig,
  caldav: caldavConfig,
  /** Local Ollama LLM runtime config (ROADMAP Phase 5), or null when not configured. */
  ollama: ollamaConfig,
} as const;
