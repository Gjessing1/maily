/**
 * One-time data heal: re-populate To/Cc on messages synced before the
 * `to_addresses`/`cc_addresses` columns existed (migration 0004). Those rows hold
 * NULL recipients, so Sent mail (where the sender is always us) shows no "to …"
 * line in the reader. We refetch ONLY the IMAP envelope — no body, no
 * attachments — so this is cheap even over a few thousand messages.
 *
 * Idempotent + convergent: after a successful fetch every touched row becomes a
 * JSON array (`'[]'` when the envelope genuinely has no recipients), so it is no
 * longer NULL and never re-fetched. Runs over a transient connection so the
 * persistent INBOX IDLE connection is never disturbed (ARCHITECTURE §2/§9).
 */
import type { AccountConfig } from '../config/accounts.js';
import { createLogger } from '../logger.js';
import { withTransientConnection } from './connection.js';
import { messagesNeedingRecipientBackfill, setRecipientAddresses } from '../db/queries.js';

const log = createLogger('backfill');
const FETCH_BATCH = 200;

type Addr = { name: string | null; address: string };

/** Map IMAP envelope address rows to our stored shape, dropping entries without an address. */
function mapAddrs(list: ReadonlyArray<{ name?: string; address?: string }> | undefined): Addr[] {
  return (list ?? [])
    .filter((a): a is { name?: string; address: string } => Boolean(a.address))
    .map((a) => ({ name: a.name || null, address: a.address }));
}

const encode = (addrs: Addr[]): string => (addrs.length ? JSON.stringify(addrs) : '[]');

/** Heal NULL To/Cc for one account. No-op once every row has been backfilled. */
export async function backfillRecipients(config: AccountConfig, accountId: string): Promise<void> {
  const pending = messagesNeedingRecipientBackfill(accountId);
  if (pending.length === 0) return;
  log.info(`${config.email}: recipient backfill — ${pending.length} message(s) need To/Cc`);

  // Group by folder so each mailbox is opened once; within a folder map UID → the
  // message id(s) at that UID (a UID is unique per folder).
  const byFolder = new Map<string, Map<number, string[]>>();
  for (const p of pending) {
    let uids = byFolder.get(p.folderPath);
    if (!uids) byFolder.set(p.folderPath, (uids = new Map()));
    const ids = uids.get(p.uid) ?? [];
    ids.push(p.messageId);
    uids.set(p.uid, ids);
  }

  let filled = 0;
  try {
    await withTransientConnection(config, async (client) => {
      for (const [path, byUid] of byFolder) {
        const lock = await client.getMailboxLock(path);
        try {
          const uids = [...byUid.keys()];
          for (let i = 0; i < uids.length; i += FETCH_BATCH) {
            const batch = uids.slice(i, i + FETCH_BATCH);
            for await (const msg of client.fetch(batch, { envelope: true }, { uid: true })) {
              const toJson = encode(mapAddrs(msg.envelope?.to));
              const ccJson = encode(mapAddrs(msg.envelope?.cc));
              for (const messageId of byUid.get(msg.uid) ?? []) {
                setRecipientAddresses(messageId, toJson, ccJson);
                filled += 1;
              }
            }
          }
        } finally {
          lock.release();
        }
      }
    });
  } catch (err) {
    log.warn(`${config.email}: recipient backfill failed:`, (err as Error).message);
  }

  log.info(`${config.email}: recipient backfill — filled ${filled}/${pending.length}`);
}
