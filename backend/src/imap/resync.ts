/**
 * Folder resync (ARCHITECTURE §2, KEY GOTCHA "never trust live IDLE alone").
 *
 * On every (re)connect and every cron pass we reconcile rather than assume the
 * local cache is current. Capability-driven:
 *   - UIDVALIDITY changed  → cached UIDs are meaningless; rebuild the folder.
 *   - CONDSTORE/QRESYNC    → fetch only flag changes since the stored MODSEQ.
 *   - always               → fetch UIDs above the last seen (new mail) and diff
 *                            the live UID set against the cache (expunges).
 *
 * The expunge diff is the provider-agnostic stand-in for QRESYNC VANISHED: cheap
 * (UID-only fetch) and correct for a single-user mailbox.
 */
import type { FolderRow } from './folders.js';
import { updateFolderSyncState } from './folders.js';
import { flagsFromSet } from './parse.js';
import {
  clearFolderUids,
  knownUids,
  messageFlags,
  messageIdForUid,
  unlinkUids,
  updateMessageFlags,
} from './store.js';
import { fetchAndStore, fullSyncFolder, type SyncContext } from './sync.js';

/** A seen/flagged change detected during resync — emitted as a live `mail:flags` signal. */
export interface FlagChange {
  messageId: string;
  seen: boolean;
  flagged: boolean;
}

export interface ResyncResult {
  /** Internal ids of newly inserted messages (for live new-mail signals). */
  insertedIds: string[];
  updated: number;
  expunged: number;
  /** Messages whose seen/flagged actually changed (for live `mail:flags` signals). */
  flagChanges: FlagChange[];
  mode: 'full' | 'incremental';
}

/**
 * Apply CONDSTORE flag changes since the last stored MODSEQ to cached messages, and
 * return the ones that actually changed. Capturing the change set lets the engine push
 * live `mail:flags` signals so read/unread set on another device (or the provider's
 * webmail) propagates to foreground clients instead of waiting for their next refetch.
 */
async function resyncFlags(
  ctx: SyncContext,
  folder: FolderRow,
  sinceModseq: number,
): Promise<FlagChange[]> {
  const changes: FlagChange[] = [];
  for await (const msg of ctx.client.fetch(
    '1:*',
    { uid: true, flags: true },
    { uid: true, changedSince: BigInt(sinceModseq) },
  )) {
    // New messages also surface here (higher MODSEQ) but have no mapping yet —
    // they are picked up by the new-UID fetch below, which parses + stores them.
    const id = messageIdForUid(folder.id, msg.uid);
    if (!id) continue;
    const flags = flagsFromSet(msg.flags);
    const before = messageFlags(id);
    updateMessageFlags(id, flags);
    if (!before || before.seen !== flags.seen || before.flagged !== flags.flagged) {
      changes.push({ messageId: id, seen: flags.seen, flagged: flags.flagged });
    }
  }
  return changes;
}

/** Detect and unlink messages expunged from the folder by diffing the live UID set. */
async function reconcileExpunges(ctx: SyncContext, folder: FolderRow): Promise<number> {
  const present = new Set<number>();
  for await (const msg of ctx.client.fetch('1:*', { uid: true }, { uid: true })) {
    present.add(msg.uid);
  }
  const gone = knownUids(folder.id).filter((uid) => !present.has(uid));
  unlinkUids(folder.id, gone);
  return gone.length;
}

/**
 * Reconcile a single folder. Opens it (lock-guarded) and runs the appropriate
 * path. Safe to call on the persistent INBOX connection or a transient cron one.
 */
export async function resyncFolder(ctx: SyncContext, folder: FolderRow): Promise<ResyncResult> {
  const lock = await ctx.client.getMailboxLock(folder.path);
  try {
    const mb = ctx.client.mailbox;
    if (!mb) throw new Error(`mailbox ${folder.path} did not open`);

    const currentUidValidity = Number(mb.uidValidity);
    const highestModseq = mb.highestModseq ? Number(mb.highestModseq) : null;
    const firstSight = folder.uidValidity === null;
    const uidValidityChanged = !firstSight && folder.uidValidity !== currentUidValidity;

    if (firstSight || uidValidityChanged) {
      ctx.log.info(
        `${folder.path}: UIDVALIDITY ${folder.uidValidity ?? 'unset'} → ${currentUidValidity}, ${
          uidValidityChanged ? 'rebuilding' : 'first sync'
        }`,
      );
      // A real UIDVALIDITY change invalidates every cached UID; wipe the mappings.
      // First sight has nothing to wipe (and may hold partial mappings from an
      // interrupted prior run that we want to keep). `fullSyncFolder` persists the
      // resync bookkeeping itself, progressively, so an interrupted pass resumes
      // incrementally next connect instead of rebuilding from scratch.
      if (uidValidityChanged) clearFolderUids(folder.id);
      const counts = await fullSyncFolder(ctx, folder, {
        uidValidity: currentUidValidity,
        highestModseq,
        uidNext: mb.uidNext,
      });
      // A full rebuild remaps everything; clients reload the folder, so no per-message
      // flag signals are needed (and the before-state is unknown anyway).
      return { ...counts, expunged: 0, flagChanges: [], mode: 'full' };
    }

    // Incremental: flags (fast path), new mail, then expunges.
    let flagChanges: FlagChange[] = [];
    if (ctx.caps.condstore && folder.highestModseq) {
      flagChanges = await resyncFlags(ctx, folder, folder.highestModseq);
    }

    const fromUid = folder.lastUid ?? 1;
    let counts: { insertedIds: string[]; updated: number } = { insertedIds: [], updated: 0 };
    if (mb.uidNext > fromUid) {
      // Pull UIDs at/after the last seen boundary; dedup makes any overlap harmless.
      const newUids: number[] = [];
      for await (const msg of ctx.client.fetch(`${fromUid}:*`, { uid: true }, { uid: true })) {
        if (msg.uid >= fromUid) newUids.push(msg.uid);
      }
      // Incremental new mail is the live, low-volume path — capture full source.
      counts = await fetchAndStore(ctx, folder, newUids, 'live');
    }

    const expunged = await reconcileExpunges(ctx, folder);

    updateFolderSyncState(folder.id, {
      uidValidity: currentUidValidity,
      highestModseq,
      lastUid: mb.uidNext,
    });
    return { ...counts, expunged, flagChanges, mode: 'incremental' };
  } finally {
    lock.release();
  }
}
