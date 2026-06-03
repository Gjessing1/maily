/**
 * Draft persistence (ROADMAP §B): "Save draft" APPENDs the composed MIME to the
 * account's \Drafts mailbox so drafts sync across devices, rather than living only
 * in the composer's local autosave. Unlike \Sent, drafts are APPENDed on *every*
 * provider (Gmail included) — there's no SMTP step, so nothing files a copy for us.
 *
 * Editing a saved draft re-saves a fresh copy and removes the old one (drafts have
 * no natural "update" over IMAP), so `removeDraft` expunges the superseded message.
 */
import type { ImapFlow } from 'imapflow';
import type { SaveDraftRequest, SaveDraftResult } from '@maily/shared';
import type { AccountConfig } from '../config/accounts.js';
import { createLogger } from '../logger.js';
import { emitSignal } from '../events.js';
import { withTransientConnection } from '../imap/connection.js';
import { markMessageDeleted } from '../imap/store.js';
import { getMessage, uidLocationForMessage } from '../db/queries.js';
import { deleteUpload } from '../storage/uploads.js';
import { buildMime } from './compose.js';

const log = createLogger('drafts');

/** Locate the \Drafts mailbox path for an account, if the server exposes one. */
async function findDraftsMailbox(client: ImapFlow): Promise<string | null> {
  const list = await client.list();
  const bySpecialUse = list.find((b) => b.specialUse === '\\Drafts');
  if (bySpecialUse) return bySpecialUse.path;
  const byName = list.find((b) => /^(drafts?|entw[üu]rfe)$/i.test(b.name));
  return byName?.path ?? null;
}

/**
 * Append the composed message to \Drafts (flagged \Draft \Seen). When the request
 * supersedes a previously-saved draft, that copy is expunged afterwards so edits
 * don't pile up duplicates.
 */
export async function saveDraft(
  config: AccountConfig,
  req: SaveDraftRequest,
): Promise<SaveDraftResult> {
  const { raw, messageId } = await buildMime(config, req);

  let savedToDrafts = false;
  await withTransientConnection(config, async (client) => {
    const drafts = await findDraftsMailbox(client);
    if (!drafts) {
      log.warn(`no \\Drafts mailbox found for ${config.email}; skipping APPEND`);
      return;
    }
    await client.append(drafts, raw, ['\\Draft', '\\Seen']);
    savedToDrafts = true;
  });

  // Staged uploads are now embedded in the appended MIME — drop the staging files.
  for (const ref of req.uploads ?? []) {
    await deleteUpload(ref.uploadId);
  }

  if (savedToDrafts && req.replaceDraftId) {
    await removeDraft(config, req.replaceDraftId);
  }

  return { messageId, savedToDrafts };
}

/**
 * Expunge a saved draft from its \Drafts mailbox and tombstone it locally so it
 * disappears from the UI immediately. Best-effort — a failure is logged, not thrown
 * (the caller's primary action, a send or re-save, has already succeeded).
 */
export async function removeDraft(config: AccountConfig, messageId: string): Promise<void> {
  const msg = getMessage(messageId);
  const loc = uidLocationForMessage(messageId);
  if (!msg || !loc) return;

  try {
    await withTransientConnection(config, async (client) => {
      const lock = await client.getMailboxLock(loc.folderPath);
      try {
        await client.messageDelete(String(loc.uid), { uid: true });
      } finally {
        lock.release();
      }
    });
  } catch (err) {
    log.warn(`failed to expunge old draft ${messageId}: ${(err as Error).message}`);
  }

  // Drop it locally regardless: the server copy is gone (or will reconcile away).
  markMessageDeleted(messageId);
  emitSignal({ type: 'mail:deleted', accountId: msg.accountId, messageId });
}
