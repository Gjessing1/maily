/**
 * Provider-agnostic MOVE-to-folder over a transient IMAP connection (ARCHITECTURE §2/§13).
 * Shared by the interactive single-delete/archive routes and the bulk cleanup trash queue:
 * UID MOVE the message(s) to a destination folder on the server, then converge the local
 * mapping onto the destination so the row stays fetchable. Never uses the IDLE connection.
 *
 * On Gmail this strips every other label; on generic IMAP it vacates the source folder.
 * imapflow falls back to COPY + `\Deleted` + EXPUNGE where MOVE is unadvertised. The
 * tombstone (`messages.deletedAt`) is preserved across the move — re-sights never clear it.
 */
import type { AccountConfig } from '../config/accounts.js';
import { withTransientConnection } from './connection.js';
import { relinkMessageToFolder } from './store.js';

/**
 * MOVE a single message (by its source folder + UID) to `dest` and relink locally.
 * uidMap (source→dest UID) is present only when the server supports MOVE/COPYUID; null
 * otherwise — in which case the destination UID is unknown until the next resync.
 */
export async function moveToFolderOnServer(
  config: AccountConfig,
  messageId: string,
  loc: { folderPath: string; uid: number },
  dest: { id: string; path: string },
): Promise<void> {
  const newUid = await withTransientConnection(config, async (client) => {
    const lock = await client.getMailboxLock(loc.folderPath);
    try {
      const res = await client.messageMove(String(loc.uid), dest.path, { uid: true });
      return res ? (res.uidMap?.get(loc.uid) ?? null) : null;
    } finally {
      lock.release();
    }
  });
  relinkMessageToFolder(messageId, dest.id, newUid);
}

/** One (messageId, uid) pair within a single source folder, for a batched MOVE. */
export interface MoveItem {
  messageId: string;
  uid: number;
}

/**
 * Batched MOVE: move every item that lives in `sourcePath` to `dest` in ONE IMAP command
 * (a comma-joined UID set) over a single transient connection, then relink each locally.
 * This is the gentle bulk primitive — one MOVE per (account, source folder) batch keeps the
 * server from being flagged for thousands of individual commands (ROADMAP Phase 6b). All
 * items MUST share `sourcePath`. Returns the moved message ids (relink applied) so the caller
 * can mark them done; on a per-item missing uidMap entry the destination UID is left null.
 */
export async function moveBatchToFolderOnServer(
  config: AccountConfig,
  items: MoveItem[],
  sourcePath: string,
  dest: { id: string; path: string },
): Promise<string[]> {
  if (items.length === 0) return [];
  const uidSet = items.map((i) => i.uid).join(',');
  const uidMap = await withTransientConnection(config, async (client) => {
    const lock = await client.getMailboxLock(sourcePath);
    try {
      const res = await client.messageMove(uidSet, dest.path, { uid: true });
      return res ? (res.uidMap ?? null) : null;
    } finally {
      lock.release();
    }
  });
  for (const item of items) {
    relinkMessageToFolder(item.messageId, dest.id, uidMap?.get(item.uid) ?? null);
  }
  return items.map((i) => i.messageId);
}
