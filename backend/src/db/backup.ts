/**
 * WAL-safe SQLite snapshots for off-host backup.
 *
 * The live DB runs in WAL mode (ARCHITECTURE §12, db/client.ts), so a plain file copy of
 * `mail.sqlite` taken by an external backup tool can be *torn*: committed data may still be
 * sitting in the `-wal` sidecar, and the copier can catch a half-written page. backrest/restic
 * (the off-host backup) therefore can't safely grab the live file directly.
 *
 * This module periodically writes a **self-contained, transactionally-consistent** copy via
 * better-sqlite3's online backup API (it copies pages under a read snapshot, yielding to
 * concurrent writers — it does NOT block sync). We write to a temp path and `rename()` it over
 * the rolling snapshot, so the backup tool only ever observes a complete file. backrest then
 * versions/dedups that single file — retention is its job, not ours.
 *
 * Restore: drop this `.bak` in as a fresh deploy's `mail.sqlite` (it opens standalone — no `-wal`
 * sidecar needed; WAL is re-established on first write). attachments/ + source/ restore from
 * backrest as normal.
 */
import { renameSync, statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { sqlite } from './client.js';
import { env } from '../env.js';
import { createLogger } from '../logger.js';

const log = createLogger('db-backup');

/**
 * Write a consistent snapshot of `source` to `destPath` atomically (temp file + rename).
 * Returns the snapshot size in bytes. `source` is injectable for tests; defaults to the live DB.
 */
export async function backupDatabaseTo(
  destPath: string,
  source: Database.Database = sqlite,
): Promise<number> {
  const tmp = `${destPath}.tmp`;
  await source.backup(tmp);
  renameSync(tmp, destPath);
  return statSync(destPath).size;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function runOnce(): Promise<void> {
  if (running) {
    // A snapshot outlasting its interval (huge DB / slow disk) must not stack up.
    log.warn('previous snapshot still running; skipping this cycle');
    return;
  }
  running = true;
  try {
    const bytes = await backupDatabaseTo(env.dbBackup.path);
    log.info(`snapshot written (${(bytes / 1_048_576).toFixed(1)} MB) → ${env.dbBackup.path}`);
  } catch (err) {
    // Non-fatal: a failed snapshot just means backrest grabs the previous good one.
    log.error('snapshot failed (non-fatal):', err);
  } finally {
    running = false;
  }
}

/**
 * Start the periodic WAL-safe snapshot. The first snapshot fires shortly after boot (off the
 * listen path), then every `MAILY_DB_BACKUP_MS`. The timer is `unref()`'d so it never holds the
 * process open during shutdown. No-op when disabled.
 */
export function startDbBackup(): void {
  if (!env.dbBackup.enabled) {
    log.info('disabled (MAILY_DB_BACKUP=false)');
    return;
  }
  setTimeout(() => void runOnce(), 60_000).unref();
  timer = setInterval(() => void runOnce(), env.dbBackup.intervalMs);
  timer.unref();
  log.info(
    `enabled — every ${(env.dbBackup.intervalMs / 3_600_000).toFixed(1)}h → ${env.dbBackup.path}`,
  );
}

export function stopDbBackup(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
