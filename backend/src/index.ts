/**
 * Backend entry point.
 *
 * Boot order: migrate → start the HTTP API + Socket.io + Web Push → start the
 * per-account IMAP sync engines (one persistent INBOX IDLE connection each, plus
 * a non-INBOX reconcile cron). See docs/ROADMAP.md and src/imap/.
 */
import type { Server as IoServer } from 'socket.io';
import { env } from './env.js';
import { sqlite } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createLogger } from './logger.js';
import { loadAccountConfigs } from './config/accounts.js';
import { startSyncEngines, type AccountEngine } from './imap/engine.js';
import { enqueueEnrichPass, shutdownWorker } from './worker/host.js';
import { buildServer } from './http/server.js';
import { attachSockets } from './sockets/index.js';
import { initWebPush, wirePushNotifications } from './push/webpush.js';
import { sweepStaleUploads } from './storage/uploads.js';
import { startContactsSync } from './contacts/carddav.js';
import { reloadContactCache } from './contacts/store.js';
import { startTrashQueue } from './cleanup/trashQueue.js';
import { startCleanupCache } from './cleanup/cache.js';
import { backfillSourceBytes } from './cleanup/sourceBytesBackfill.js';
import { startOutbox, pendingSendUploadIds } from './outbox/runner.js';

const log = createLogger('maily');

function reportBoot(): void {
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => (row as { name: string }).name);

  log.info(`backend — ${env.nodeEnv}`);
  log.info(`  db:          ${env.dbPath}`);
  log.info(`  attachments: ${env.attachmentsDir}`);
  log.info(`  journal:     ${sqlite.pragma('journal_mode', { simple: true })}`);
  log.info(`  tables:      ${tables.length}`);
}

function installShutdown(engines: AccountEngine[], io: IoServer): void {
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}, shutting down…`);
    io.close();
    await Promise.allSettled([...engines.map((e) => e.stop()), shutdownWorker()]);
    sqlite.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

async function main(): Promise<void> {
  runMigrations();
  reportBoot();

  // Warm the sender-name enrichment map from any contacts already cached on disk.
  reloadContactCache();

  // Transport layer first so the PWA can authenticate even before mail syncs.
  const app = await buildServer();
  const io = attachSockets(app);
  initWebPush();
  wirePushNotifications();
  await app.listen({ host: '0.0.0.0', port: env.port });
  log.info(`HTTP + Socket.io listening on :${env.port}`);

  // Self-healing storage metric: fill source_bytes for any archived row left NULL (rows
  // archived before the column existed) or zeroed by a buggy write, so the cleanup byte
  // estimate and the detach size preview reflect the true on-disk `.eml` cost. A no-op once
  // every archived `.eml` has been measured. Deferred to *after* listen and off the listen
  // path (setImmediate) so a large archive can never gate the HTTP server coming up.
  setImmediate(() => {
    try {
      backfillSourceBytes();
    } catch (err) {
      log.error('source_bytes backfill failed (non-fatal):', err);
    }
  });

  // Clear abandoned composer uploads left from previous runs — but keep any still referenced
  // by a queued send (a scheduled "send later" can outlive the staging cutoff).
  void sweepStaleUploads(pendingSendUploadIds());

  // Keep the contacts cache fresh from the Radicale addressbook (no-op if unset).
  startContactsSync();

  // Resume any cleanup trash-queue work left pending from a previous run, and trickle new
  // bulk-cleanup MOVEs to Trash thereafter (Phase 6b — rate-limited, restart-safe).
  startTrashQueue();

  // Server-owned outbox: commit deferred sends (undo-send / scheduled) and undoable
  // delete/archive MOVEs at their due time — independent of whether the PWA is open.
  startOutbox();

  // Precompute the Cleanup Dashboard aggregates (warm at boot, re-warm after mail changes)
  // so entering the Cleanup screen is served from memory instead of full-table scans.
  startCleanupCache();

  const accounts = loadAccountConfigs();
  if (accounts.length === 0) {
    log.warn('no accounts configured (ACCOUNT_<n>_* env vars) — sync engine idle');
    installShutdown([], io);
    return;
  }

  log.info(`starting sync engines for ${accounts.length} account(s)`);
  const engines = startSyncEngines(accounts);
  installShutdown(engines, io);

  // Kick the enrichment pipeline once at boot so backlog + any mail enqueued while the
  // process was down (or synced before the pipeline existed) gets drained (Phase 4).
  enqueueEnrichPass();
}

void main();
