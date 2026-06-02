/**
 * Bridge live Socket.io signals (foreground, §3) into the Dexie cache so mounted
 * views update without polling. Signals are lightweight; the actual message data
 * is pulled over HTTP and written to the cache, where useLiveQuery picks it up.
 */
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { onSignal } from '../api/socket';
import { cacheBody, patchCachedFlags, removeCachedMessage } from '../db/cache';

export interface SyncProgress {
  accountId: string;
  done: number;
  total: number;
}

export function useSignals(): { progress: SyncProgress | null } {
  const [progress, setProgress] = useState<SyncProgress | null>(null);

  useEffect(() => {
    return onSignal((signal) => {
      switch (signal.type) {
        case 'mail:new':
          // Pull the new message (with body) and cache it; the inbox liveQuery
          // will surface it because folderIds includes the inbox folder.
          api
            .message(signal.messageId)
            .then(cacheBody)
            .catch(() => undefined);
          break;
        case 'mail:flags':
          void patchCachedFlags(signal.messageId, {
            seen: signal.seen,
            flagged: signal.flagged,
          });
          break;
        case 'mail:deleted':
          // Tombstoned on the backend (moved to Trash) — drop it from the local cache
          // so the list/reader stop showing it (it's filtered server-side too).
          void removeCachedMessage(signal.messageId);
          break;
        case 'mail:archived':
          // Moved out of the inbox to Archive. Drop the local copy; it re-syncs into
          // the Archive folder when that folder is next viewed.
          void removeCachedMessage(signal.messageId);
          break;
        case 'sync:progress':
          setProgress({
            accountId: signal.accountId,
            done: signal.done,
            total: signal.total,
          });
          if (signal.done >= signal.total) {
            setTimeout(() => setProgress(null), 1500);
          }
          break;
        default:
          break;
      }
    });
  }, []);

  return { progress };
}
