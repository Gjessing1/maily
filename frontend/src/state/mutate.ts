/**
 * The one client path for a read/star change. Owns the offline guard, the optimistic cache
 * patch and the revert when the server refuses the request, so call sites only say what changed.
 *
 * The server applies the change locally at once and queues the provider STORE (outbox intent);
 * if the provider never takes it, the server reverts it and sends `mail:flags` +
 * `mail:action-failed`, which state/signals.ts applies — so a late failure needs nothing here.
 * Delete and archive have an undo window and go through state/undo.ts instead.
 */
import { api } from '../api/client';
import { patchCachedFlags } from '../db/cache';
import { isConnected, OFFLINE_READ_ONLY_MESSAGE } from './connectivity';
import { showNotice } from './undo';

export interface FlagPatch {
  seen?: boolean;
  flagged?: boolean;
}

export interface MutateOptions {
  /**
   * Mirror the change into state the cache doesn't drive (a result list, a toggle button).
   * Called with the patch when applied and with its inverse if the server refuses it.
   */
  onApply?: (id: string, flags: FlagPatch) => void;
  /** Background changes (mark read on open): no offline or failure notice. */
  quiet?: boolean;
}

function invert(flags: FlagPatch): FlagPatch {
  const out: FlagPatch = {};
  if (flags.seen !== undefined) out.seen = !flags.seen;
  if (flags.flagged !== undefined) out.flagged = !flags.flagged;
  return out;
}

/**
 * Set flags on each message. Returns false (and changes nothing) when offline — offline mail is
 * read-only until there is a persistent client outbox.
 */
export function mutateFlags(ids: string[], flags: FlagPatch, opts: MutateOptions = {}): boolean {
  if (!isConnected()) {
    if (!opts.quiet) showNotice(OFFLINE_READ_ONLY_MESSAGE);
    return false;
  }
  for (const id of ids) {
    void patchCachedFlags(id, flags);
    opts.onApply?.(id, flags);
    api.setFlags(id, flags).catch(() => {
      const back = invert(flags);
      void patchCachedFlags(id, back);
      opts.onApply?.(id, back);
      if (!opts.quiet) showNotice('Couldn’t update — reverted');
    });
  }
  return true;
}
