/**
 * Folder synchronisation: fetch messages, parse them, persist via the store.
 *
 * What we pull over IMAP per message: envelope, flags, BODYSTRUCTURE, internal
 * date, the References header, and — separately and only when present — the
 * text/plain and text/html body parts. We deliberately do NOT fetch full message
 * source, because that would drag attachment bytes over the wire in bulk
 * (ARCHITECTURE §4 / KEY GOTCHA). Attachment bytes are fetched on demand later.
 */
import { randomUUID } from 'node:crypto';
import type { FetchQueryObject, ImapFlow } from 'imapflow';
import type { Logger } from '../logger.js';
import type { Capabilities } from './connection.js';
import type { FolderRow } from './folders.js';
import type { CapturedMessage, FetchMessage } from './message-shape.js';
import { env } from '../env.js';
import { canDownloadSource, recordDownloadedBytes } from './budget.js';
import { deriveBodyFromSource } from './source-parse.js';
import { discardSource, sourcePathFor, writeSourceStream } from '../storage/source.js';
import { updateFolderSyncState } from './folders.js';
import { extractStructure, flagsFromSet } from './parse.js';
import { buildParsedMessage, capture } from './message-shape.js';
import {
  findExistingId,
  messageIdForUid,
  setMessageSourcePath,
  sourcePathForMessage,
  touchKnownMessage,
  upsertMessage,
} from './store.js';

/**
 * Local cache window — roughly one year by default (ARCHITECTURE §1). A value of 0
 * means "all": no `since` filter, sync the entire folder (ROADMAP §3.7.E).
 */
const CACHE_WINDOW_DAYS = env.cacheWindowDays;
const FETCH_BATCH = 100;

export interface SyncContext {
  client: ImapFlow;
  accountId: string;
  caps: Capabilities;
  log: Logger;
}

/** The FETCH query shape we use everywhere — header-and-structure only, no source. */
const FETCH_QUERY: FetchQueryObject = {
  uid: true,
  flags: true,
  envelope: true,
  bodyStructure: true,
  internalDate: true,
  size: true,
  threadId: true,
  headers: ['references'],
};

async function streamToString(
  stream: NodeJS.ReadableStream,
  charset: string | undefined,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const buf = Buffer.concat(chunks);
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch {
    return buf.toString('utf-8');
  }
}

/** Download a single (small) text body part, transfer-decoded by imapflow. */
async function downloadTextPart(
  ctx: SyncContext,
  uid: number,
  part: string,
): Promise<string | null> {
  try {
    const result = await ctx.client.download(String(uid), part, { uid: true });
    if (!result?.content) return null;
    return await streamToString(result.content, result.meta?.charset);
  } catch (err) {
    ctx.log.warn(`failed to download part ${part} of uid ${uid}:`, (err as Error).message);
    return null;
  }
}

/** Bulk/body-only body acquisition: download just the text/plain + text/html parts. */
async function downloadBodyParts(
  ctx: SyncContext,
  msg: CapturedMessage,
): Promise<{ bodyText: string | null; bodyHtml: string | null }> {
  const structure = extractStructure(msg.bodyStructure);
  const bodyText = structure.textPartId
    ? await downloadTextPart(ctx, msg.uid, structure.textPartId)
    : null;
  const bodyHtml = structure.htmlPartId
    ? await downloadTextPart(ctx, msg.uid, structure.htmlPartId)
    : null;
  return { bodyText, bodyHtml };
}

/** A staged full-source capture: the pre-assigned UUID, its `.eml` path, and the body. */
interface SourceCapture {
  id: string;
  sourcePath: string;
  body: { bodyText: string | null; bodyHtml: string | null };
}

/**
 * Stream a message's complete RFC822 to `sourcePath` and charge the bytes to the shared
 * per-day budget. Returns the byte count, or null on fetch failure (the staged file is
 * discarded). Callers MUST budget-check (`canDownloadSource`) before invoking — this is
 * the single place source bytes are pulled off the wire, for both the live capture and
 * the historical sweep.
 */
async function streamSourceToDisk(
  ctx: SyncContext,
  uid: number,
  sourcePath: string,
): Promise<number | null> {
  try {
    const { content } = await ctx.client.download(String(uid), undefined, { uid: true });
    if (!content) return null;
    const bytes = await writeSourceStream(content, sourcePath);
    recordDownloadedBytes(bytes);
    return bytes;
  } catch (err) {
    ctx.log.warn(`full-source fetch failed for uid ${uid}:`, (err as Error).message);
    await discardSource(sourcePath);
    return null;
  }
}

/**
 * Live-path full-source capture (ROADMAP §3.7.E — the day-one invariant). Streams the
 * complete RFC822 to `<sourceDir>/{account}/{uuid}/source.eml`, charges the bytes to
 * the shared per-day budget, and derives the body by parsing that `.eml`. Returns null
 * (caller falls back to body-only) when the budget is exhausted or the fetch fails, so
 * a new message is never lost — it just isn't archived yet (the sweep gets it later).
 */
async function captureFullSource(
  ctx: SyncContext,
  msg: CapturedMessage,
): Promise<SourceCapture | null> {
  if (!canDownloadSource()) return null;
  const id = randomUUID();
  const sourcePath = sourcePathFor(ctx.accountId, id);
  const bytes = await streamSourceToDisk(ctx, msg.uid, sourcePath);
  if (bytes === null) return null;
  const body = await deriveBodyFromSource(sourcePath);
  return { id, sourcePath, body };
}

/**
 * Upgrade an already-stored (body-only) message to full source: archive its `.eml` under
 * its existing UUID-partitioned path and set `source_path`. The sweep's hot path on the
 * cache window, where rows already exist from the body-only bulk sync. Returns true on
 * success; false on fetch failure (the caller skips this UID and moves on).
 */
async function archiveSourceForExisting(
  ctx: SyncContext,
  messageId: string,
  uid: number,
): Promise<boolean> {
  const sourcePath = sourcePathFor(ctx.accountId, messageId);
  const bytes = await streamSourceToDisk(ctx, uid, sourcePath);
  if (bytes === null) return false;
  setMessageSourcePath(messageId, sourcePath);
  return true;
}

export interface StoreCounts {
  /** Internal ids of newly inserted messages (for live new-mail signals). */
  insertedIds: string[];
  updated: number;
}

/**
 * Fetch mode (ROADMAP §3.7.E). `live` is the low-volume IDLE path: it captures the
 * full RFC822 source and derives the parsed row from it (the day-one canonical
 * invariant). `bulk` is the body-only fast path for the initial cache-window sync;
 * its backlog gets archived later by the throttled, budgeted full-source sweep.
 */
export type FetchMode = 'live' | 'bulk';

/** Fetch a set of UIDs and persist them into the folder. */
export async function fetchAndStore(
  ctx: SyncContext,
  folder: FolderRow,
  uids: number[],
  mode: FetchMode = 'bulk',
): Promise<StoreCounts> {
  const insertedIds: string[] = [];
  let updated = 0;

  for (let i = 0; i < uids.length; i += FETCH_BATCH) {
    const batch = uids.slice(i, i + FETCH_BATCH);

    // Phase 1: drain the fetch fully (no other IMAP command may run mid-stream).
    const captured: CapturedMessage[] = [];
    for await (const msg of ctx.client.fetch(batch, FETCH_QUERY, { uid: true })) {
      captured.push(capture(msg as Exclude<FetchMessage, false>));
    }

    // Phase 2: connection is free now — persist. Dedup FIRST using identity from
    // the envelope (gm_msgid / message_id, already in hand), and only acquire the
    // body for genuinely new messages. A re-sighting (e.g. an INBOX rebuild for a
    // message already stored via All Mail) just refreshes flags + folder mapping —
    // no body re-fetch — which is what keeps a full rebuild from taking hours.
    for (const msg of captured) {
      const gmMsgId = ctx.caps.gmail ? (msg.emailId ?? null) : null;
      const messageId = msg.envelope?.messageId ?? null;
      const knownId = findExistingId(ctx.accountId, gmMsgId, messageId);
      if (knownId) {
        touchKnownMessage(knownId, folder.id, msg.uid, flagsFromSet(msg.flags), folder.role);
        updated += 1;
        continue;
      }

      // Live path: capture full source once and derive the body from it. Falls back
      // to body-only when the byte budget is spent or the source fetch fails.
      const cap = mode === 'live' ? await captureFullSource(ctx, msg) : null;
      const body = cap ? cap.body : await downloadBodyParts(ctx, msg);
      const parsed = buildParsedMessage(ctx.caps, msg, body, cap?.sourcePath ?? null);
      const result = upsertMessage(
        ctx.accountId,
        folder.id,
        msg.uid,
        parsed,
        folder.role,
        cap ? { id: cap.id } : undefined,
      );
      if (result.inserted) {
        insertedIds.push(result.id);
      } else {
        updated += 1;
        // Dedup race: the row already existed, so the staged `.eml` is orphaned.
        if (cap) await discardSource(cap.sourcePath);
      }
    }
  }

  return { insertedIds, updated };
}

/**
 * Full sync of a folder's cache window. Used on first sight of a folder and when
 * UIDVALIDITY changes (cached UIDs become meaningless and must be rebuilt).
 *
 * Persists resync bookkeeping AS IT GOES so a process killed mid-sync resumes
 * incrementally on the next connect instead of rebuilding from scratch (the bug
 * behind a never-completing INBOX full sync re-running on every restart):
 *   - UIDVALIDITY is stored up front, so the next connect takes the incremental
 *     path rather than re-detecting a "first sight" and rebuilding again.
 *   - `lastUid` starts at the window's lower bound and advances per batch, so the
 *     incremental resume rescans only from the lowest UID not yet persisted —
 *     staying inside the cache window (never fetching all history from UID 1).
 * Re-sighting already-stored messages on resume is cheap (`fetchAndStore` dedups
 * before any body download), so the catch-up is fast.
 */
export async function fullSyncFolder(
  ctx: SyncContext,
  folder: FolderRow,
  state: { uidValidity: number; highestModseq: number | null; uidNext: number },
): Promise<StoreCounts> {
  // CACHE_WINDOW_DAYS === 0 ⇒ "all": no date floor, enumerate the whole folder.
  const searchQuery =
    CACHE_WINDOW_DAYS > 0
      ? { since: new Date(Date.now() - CACHE_WINDOW_DAYS * 24 * 60 * 60 * 1000) }
      : { all: true };
  const uids = ((await ctx.client.search(searchQuery, { uid: true })) || []).sort((a, b) => a - b);
  ctx.log.info(
    `full sync ${folder.path}: ${uids.length} message(s)` +
      (CACHE_WINDOW_DAYS > 0 ? ' in window' : ' (full folder)'),
  );

  // Resume floor: one below the lowest window UID (or just below UIDNEXT when the
  // window is empty). Stored before any body fetch so an interrupted run resumes
  // from the window bottom, never from UID 1.
  const floor = (uids[0] ?? state.uidNext) - 1;
  updateFolderSyncState(folder.id, {
    uidValidity: state.uidValidity,
    highestModseq: state.highestModseq,
    lastUid: floor,
  });

  const insertedIds: string[] = [];
  let updated = 0;
  for (let i = 0; i < uids.length; i += FETCH_BATCH) {
    const batch = uids.slice(i, i + FETCH_BATCH);
    const counts = await fetchAndStore(ctx, folder, batch);
    insertedIds.push(...counts.insertedIds);
    updated += counts.updated;
    // Advance the resume floor as each batch lands (UIDs are ascending).
    const batchTop = batch[batch.length - 1];
    if (batchTop !== undefined) updateFolderSyncState(folder.id, { lastUid: batchTop });
  }

  // Caught up: future incremental passes fetch only mail at/after UIDNEXT.
  updateFolderSyncState(folder.id, { lastUid: state.uidNext });
  return { insertedIds, updated };
}

/** Pause between sweep batches so the historical backfill stays gentle on the server. */
const SWEEP_INTER_BATCH_MS = 1_000;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface SweepResult {
  /** Existing body-only rows upgraded to full source this pass. */
  archived: number;
  /** Pre-cache-window messages newly inserted with full source this pass. */
  inserted: number;
  /** UIDs skipped (already archived, vanished, or a transient fetch failure). */
  skipped: number;
  /** True when the folder is archived all the way down to UID 1. */
  done: boolean;
  /** True when the pass stopped early because the daily byte budget ran out. */
  budgetExhausted: boolean;
}

/**
 * Resumable, throttled, budgeted full-source sweep (ROADMAP §3.7.E — the historical
 * backfill). Walks a folder's UIDs from the `oldest_synced_uid` watermark DOWNWARD,
 * archiving the raw `.eml` for every message that lacks one:
 *   - a row already exists (body-only) → upgrade it in place (set `source_path`);
 *   - no row yet (older than the cache window) → fetch + insert with full source.
 * The watermark advances as each batch lands, so a pass interrupted by restart or
 * disconnect resumes from where it stopped instead of restarting. Every source byte is
 * charged to the shared per-day budget (`budget.ts`); when it runs out the pass stops
 * and resumes after the UTC day rolls — so the provider's ~2.5 GB/day cap is never
 * breached. Runs over a transient connection (caller's), never the INBOX IDLE one.
 *
 * NOTE: the Pipeline Horizon (ROADMAP Phase 4) is not yet built — there is no enrichment
 * pipeline for a deep backfill to flood — so this sweep is not horizon-gated. When the
 * pipeline lands, the ingest hook must tier old swept mail (search/analytical only) so a
 * years-deep backfill can't fire operational side effects.
 */
export async function sweepFolderSource(ctx: SyncContext, folder: FolderRow): Promise<SweepResult> {
  const empty: SweepResult = {
    archived: 0,
    inserted: 0,
    skipped: 0,
    done: false,
    budgetExhausted: false,
  };
  // Not yet first-synced: let resync/cron populate the folder before backfilling source.
  if (folder.uidValidity === null) return empty;
  if (!canDownloadSource()) return { ...empty, budgetExhausted: true };

  const lock = await ctx.client.getMailboxLock(folder.path);
  try {
    const mb = ctx.client.mailbox;
    if (!mb) throw new Error(`mailbox ${folder.path} did not open`);

    // Process UIDs strictly below the watermark; the first pass starts at the top of
    // the mailbox (UIDNEXT−1) and re-considers the recent window — cheap, since those
    // rows are either already archived (skip) or get upgraded in place.
    const ceiling = (folder.oldestSyncedUid ?? mb.uidNext) - 1;
    if (ceiling < 1) return { ...empty, done: true };

    const all = ((await ctx.client.search({ all: true }, { uid: true })) || [])
      .filter((u) => u <= ceiling)
      .sort((a, b) => b - a); // descending — oldest mail last
    if (all.length === 0) {
      updateFolderSyncState(folder.id, { oldestSyncedUid: 1 });
      return { ...empty, done: true };
    }

    let archived = 0;
    let inserted = 0;
    let skipped = 0;
    for (let i = 0; i < all.length; i += FETCH_BATCH) {
      if (!canDownloadSource()) {
        return { archived, inserted, skipped, done: false, budgetExhausted: true };
      }
      const batch = all.slice(i, i + FETCH_BATCH); // descending

      // Drain the fetch fully before any download (imapflow serial-command deadlock rule).
      const byUid = new Map<number, CapturedMessage>();
      for await (const msg of ctx.client.fetch(batch, FETCH_QUERY, { uid: true })) {
        const captured = capture(msg as Exclude<FetchMessage, false>);
        byUid.set(captured.uid, captured);
      }

      // `lowestDone` tracks the lowest UID we've fully handled this batch; the watermark
      // only advances to it, so a mid-batch budget stop never skips unprocessed mail.
      let lowestDone = ceiling + 1;
      let budgetStop = false;
      for (const uid of batch) {
        const msg = byUid.get(uid);
        if (!msg) {
          skipped += 1; // vanished between search and fetch (expunged) — nothing to archive
          lowestDone = uid;
          continue;
        }

        // Dedup by identity first (covers a Gmail message seen across folders), then by
        // (folder, uid) for messages without a usable Message-ID. A hit means the row
        // exists; if it already has source we skip, else we upgrade it in place.
        const gmMsgId = ctx.caps.gmail ? (msg.emailId ?? null) : null;
        const messageId = msg.envelope?.messageId ?? null;
        const existingId =
          findExistingId(ctx.accountId, gmMsgId, messageId) ?? messageIdForUid(folder.id, uid);

        if (existingId) {
          if (sourcePathForMessage(existingId)) {
            skipped += 1;
            lowestDone = uid;
            continue;
          }
          if (!canDownloadSource()) {
            budgetStop = true;
            break;
          }
          if (await archiveSourceForExisting(ctx, existingId, uid)) archived += 1;
          else skipped += 1;
          lowestDone = uid;
          continue;
        }

        // Genuinely new (older than the cache window): insert with full source.
        if (!canDownloadSource()) {
          budgetStop = true;
          break;
        }
        const cap = await captureFullSource(ctx, msg);
        if (cap) {
          const parsed = buildParsedMessage(ctx.caps, msg, cap.body, cap.sourcePath);
          const result = upsertMessage(ctx.accountId, folder.id, uid, parsed, folder.role, {
            id: cap.id,
          });
          if (result.inserted) inserted += 1;
          else {
            await discardSource(cap.sourcePath); // dedup race: row appeared meanwhile
            skipped += 1;
          }
        } else {
          skipped += 1; // transient fetch failure — skip and let the watermark advance
        }
        lowestDone = uid;
      }

      if (lowestDone <= ceiling) updateFolderSyncState(folder.id, { oldestSyncedUid: lowestDone });
      if (budgetStop) {
        return { archived, inserted, skipped, done: false, budgetExhausted: true };
      }
      await delay(SWEEP_INTER_BATCH_MS);
    }

    // Every UID below the ceiling processed → folder archived to the bottom.
    updateFolderSyncState(folder.id, { oldestSyncedUid: 1 });
    return { archived, inserted, skipped, done: true, budgetExhausted: false };
  } finally {
    lock.release();
  }
}
