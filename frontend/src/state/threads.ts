/**
 * Conversation grouping for list views (ARCHITECTURE §11). Folds the flat,
 * already-cached message rows of a folder into one row per thread. Grouping is done
 * on the client over the loaded page set — correct for the common case (an inbox
 * conversation's messages all live in the inbox); the count reflects only the
 * messages present in the current view, not Sent replies in another folder.
 */
import type { CachedMessage } from '../db/cache';
import { senderName } from '../ui/format';

export interface Conversation {
  /** Representative (most recent) message — drives the row's link, date and subject. */
  latest: CachedMessage;
  /** Every message id in the conversation, newest-first. Thread-aware actions fan out over these. */
  ids: string[];
  /** Messages in this conversation present in the current view. */
  count: number;
  /** Any message unread (the row reads as unread if so). */
  anyUnread: boolean;
  /** Any message flagged. */
  anyFlagged: boolean;
  /** Any message carries a non-inline attachment. */
  hasAttachment: boolean;
  /** Distinct sender display names, chronological (oldest → newest). */
  participants: string[];
}

const receivedMs = (m: { receivedAt: string | null }): number =>
  m.receivedAt ? Date.parse(m.receivedAt) : 0;

/**
 * Group rows into conversations. `enabled === false` returns one conversation per
 * message (the flat list, unified through the same shape). Output is fully ordered:
 * conversations by their latest message (newest-first), then — when `unreadAtTop` —
 * conversations with any unread message floated above the rest (stable).
 */
export function groupConversations(
  rows: CachedMessage[],
  { enabled, unreadAtTop }: { enabled: boolean; unreadAtTop: boolean },
): Conversation[] {
  const order: string[] = [];
  const groups = new Map<string, CachedMessage[]>();
  for (const m of rows) {
    // Thread id is the grouping key when conversation view is on and the message has
    // one; otherwise the message stands alone (its own id, namespaced so a thread id
    // can never collide with it).
    const key = enabled && m.threadId ? m.threadId : `m:${m.id}`;
    const existing = groups.get(key);
    if (existing) existing.push(m);
    else {
      groups.set(key, [m]);
      order.push(key);
    }
  }

  const conversations = order.map((key): Conversation => {
    const members = groups
      .get(key)!
      .slice()
      .sort((a, b) => receivedMs(b) - receivedMs(a));
    const latest = members[0]!;
    const participants: string[] = [];
    const seenParty = new Set<string>();
    // Walk oldest → newest so the participant list reads in conversation order.
    for (let i = members.length - 1; i >= 0; i -= 1) {
      const m = members[i]!;
      const id = (m.fromAddress ?? m.fromName ?? '').toLowerCase();
      if (!id || seenParty.has(id)) continue;
      seenParty.add(id);
      participants.push(senderName(m.fromName, m.fromAddress));
    }
    return {
      latest,
      ids: members.map((m) => m.id),
      count: members.length,
      anyUnread: members.some((m) => !m.seen),
      anyFlagged: members.some((m) => m.flagged),
      hasAttachment: members.some((m) => m.attachments.some((a) => !a.isInline)),
      participants,
    };
  });

  conversations.sort((a, b) => receivedMs(b.latest) - receivedMs(a.latest));
  if (unreadAtTop) {
    // Stable partition: unread conversations first, original (date) order preserved
    // within each side. Matches the per-message unread-at-top behaviour at thread level.
    conversations.sort((a, b) => Number(a.anyUnread ? 0 : 1) - Number(b.anyUnread ? 0 : 1));
  }
  return conversations;
}
