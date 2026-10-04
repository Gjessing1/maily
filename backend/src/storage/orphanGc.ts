/**
 * Orphan-file GC for the on-disk message store (`attachments/` + `source/`).
 *
 * maily soft-deletes (tombstones, ARCHITECTURE §13), so `ON DELETE CASCADE` rarely fires and the
 * paths that unlink files (Purge Trash, delete-forever, `discardSource`) cover the normal flows.
 * Real orphans come from the rest: permanent row deletes, UIDVALIDITY clears, and downloads that
 * died between writing the file and recording its path. Prod measured ~1.8k such `.eml` files
 * (all with no message row at all) before this job existed.
 *
 * A file is an orphan when its absolute path is referenced by NO `messages.source_path` and NO
 * `attachments.storage_path`, and it is older than a grace window. The grace window matters: the
 * live capture writes `source.eml` under a pre-minted UUID *before* the row is inserted, and a
 * lazy attachment download writes its bytes before `markAttachmentDownloaded` records them.
 *
 * Scope is exactly `attachments/` + `source/`; never `uploads/` (its own sweep), `backups/` or
 * `app/`. A future export feature must keep its files outside these roots, since a hard link
 * into them would look like an orphan here.
 *
 * Safety brake: if more than {@link MAX_ORPHAN_RATIO} of the scanned files look orphaned, the
 * run deletes nothing. That ratio is the signature of a mismatched data dir or a fresh/restored
 * DB pointed at an old volume, not of genuine leftovers.
 */
import type { Dirent } from 'node:fs';
import { readdir, rmdir, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sqlite } from '../db/client.js';
import { getSetting, putSetting } from '../db/settings.js';
import { env } from '../env.js';
import { createLogger } from '../logger.js';

const log = createLogger('orphan-gc');

/** Files younger than this are never touched (in-flight capture / download). */
const GRACE_MS = 24 * 60 * 60 * 1000;
/** Abort the whole run when more than this fraction of scanned files look orphaned. */
const MAX_ORPHAN_RATIO = 0.25;
/** Minimum spacing between runs; persisted so frequent redeploys don't reset it. */
const RUN_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
/** How often the scheduler checks whether a run is due. */
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
/** First check after boot, well clear of the boot-time sync + backfill burst. */
const FIRST_CHECK_DELAY_MS = 15 * 60_000;
/** `app_settings` key holding the epoch-ms of the last completed run. */
const STATE_KEY = 'storage.orphanGc.lastRunAt';

export interface OrphanGcResult {
  scanned: number;
  orphans: number;
  deleted: number;
  bytes: number;
  /** Set when the safety brake tripped; nothing was deleted. */
  aborted?: string;
}

/** Every file path the DB still points at, normalised to absolute form. */
export function referencedPaths(): Set<string> {
  const refs = new Set<string>();
  const rows = sqlite
    .prepare<[], string>(
      `SELECT source_path FROM messages WHERE source_path IS NOT NULL
       UNION ALL
       SELECT storage_path FROM attachments WHERE storage_path IS NOT NULL`,
    )
    .pluck();
  for (const p of rows.iterate()) refs.add(resolve(p));
  return refs;
}

/** Async recursive walk; yields to the event loop on every directory read. */
async function walk(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // root missing or vanished mid-walk
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile()) out.push(p);
  }
}

/**
 * Delete unreferenced files under `roots` older than the grace window, then drop the message
 * directories that emptied. Pure with respect to the DB (the caller supplies `referenced`), so
 * tests can drive it directly.
 */
export async function sweepOrphans(
  roots: string[],
  referenced: Set<string>,
  now = Date.now(),
): Promise<OrphanGcResult> {
  const files: string[] = [];
  for (const root of roots) await walk(root, files);

  const candidates = files.filter((f) => !referenced.has(f));
  const result: OrphanGcResult = { scanned: files.length, orphans: 0, deleted: 0, bytes: 0 };

  const orphans: { path: string; size: number }[] = [];
  for (const path of candidates) {
    try {
      const st = await stat(path);
      if (now - st.mtimeMs >= GRACE_MS) orphans.push({ path, size: st.size });
    } catch {
      // Vanished between walk and stat — nothing to do.
    }
  }
  result.orphans = orphans.length;

  if (orphans.length > 0 && orphans.length > files.length * MAX_ORPHAN_RATIO) {
    result.aborted =
      `${orphans.length}/${files.length} files unreferenced (> ${MAX_ORPHAN_RATIO * 100}%) — ` +
      `data dir / DB mismatch? deleting nothing`;
    return result;
  }

  const rootSet = new Set(roots.map((r) => resolve(r)));
  for (const { path, size } of orphans) {
    try {
      await unlink(path);
      result.deleted++;
      result.bytes += size;
    } catch (err) {
      log.warn(`could not unlink ${path}: ${(err as Error).message}`);
      continue;
    }
    // Remove the now-empty parents up to (never including) the root: the message dir,
    // then the account dir if that was its last message.
    let dir = resolve(path, '..');
    while (!rootSet.has(dir) && [...rootSet].some((r) => dir.startsWith(r + '/'))) {
      try {
        await rmdir(dir);
      } catch {
        break; // not empty (or gone) — stop climbing
      }
      dir = resolve(dir, '..');
    }
  }
  return result;
}

/** One full GC pass over the live store. */
export async function runOrphanGc(now = Date.now()): Promise<OrphanGcResult> {
  const result = await sweepOrphans([env.attachmentsDir, env.sourceDir], referencedPaths(), now);
  if (result.aborted) {
    log.error(`aborted: ${result.aborted}`);
  } else {
    log.info(
      `scanned ${result.scanned} file(s): removed ${result.deleted}/${result.orphans} orphan(s), ` +
        `${(result.bytes / 1_048_576).toFixed(1)} MB reclaimed`,
    );
    // Only a clean pass counts; an aborted one re-checks tomorrow so the log keeps shouting.
    putSetting(STATE_KEY, now);
  }
  return result;
}

let running = false;

async function checkDue(): Promise<void> {
  if (running) return;
  if (Date.now() - getSetting<number>(STATE_KEY, 0) < RUN_EVERY_MS) return;
  running = true;
  try {
    await runOrphanGc();
  } catch (err) {
    log.error('run failed (non-fatal):', err);
  } finally {
    running = false;
  }
}

/**
 * Start the weekly orphan GC. Checks shortly after boot and then daily, running only when the
 * persisted last run is a week old. Timers are `unref()`'d. No-op when `MAILY_ORPHAN_GC=false`.
 */
export function startOrphanGc(): void {
  if (!env.orphanGcEnabled) {
    log.info('disabled (MAILY_ORPHAN_GC=false)');
    return;
  }
  setTimeout(() => void checkDue(), FIRST_CHECK_DELAY_MS).unref();
  setInterval(() => void checkDue(), CHECK_EVERY_MS).unref();
}
