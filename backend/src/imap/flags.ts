/**
 * Batched flag STORE over one transient IMAP connection (never the IDLE one). The outbox groups
 * every due flag intent by (folder, flag, value), so a bulk "mark read" is one STORE per folder
 * instead of one login per message.
 */
import type { AccountConfig } from '../config/accounts.js';
import { withTransientConnection } from './connection.js';

export interface FlagStore {
  folderPath: string;
  flag: '\\Seen' | '\\Flagged';
  value: boolean;
  uids: number[];
}

/**
 * Run each STORE; returns one entry per input — null on success, else the error message. A
 * failure to connect at all throws, failing every STORE in the call.
 */
export async function storeFlagsOnServer(
  config: AccountConfig,
  stores: FlagStore[],
): Promise<(string | null)[]> {
  if (stores.length === 0) return [];
  return withTransientConnection(config, async (client) => {
    const results: (string | null)[] = [];
    for (const s of stores) {
      try {
        const lock = await client.getMailboxLock(s.folderPath);
        try {
          const op = s.value ? client.messageFlagsAdd : client.messageFlagsRemove;
          await op.call(client, s.uids.join(','), [s.flag], { uid: true });
        } finally {
          lock.release();
        }
        results.push(null);
      } catch (err) {
        results.push((err as Error).message);
      }
    }
    return results;
  });
}
