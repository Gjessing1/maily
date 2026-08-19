/**
 * The one place a "new mail" notification is worded, shared by every transport so the
 * PWA, the Android APK and a stream catch-up all say exactly the same thing.
 */
import type { MessageRow } from '../db/queries.js';
import { contactNameFor } from '../contacts/store.js';

export interface MailNotification {
  title: string;
  body: string;
  /** Internal message UUID — the deep-link target a notification tap opens. */
  messageId: string;
  /** Arrival time, in ms. The stream's catch-up cursor is expressed in these. */
  receivedAt: number;
}

export function notificationFor(m: MessageRow): MailNotification {
  return {
    // Radicale-first sender name (ROADMAP §3.7.D), matching the DTO precedence.
    title: contactNameFor(m.fromAddress) ?? m.fromName ?? m.fromAddress ?? 'New mail',
    body: m.subject ?? '(no subject)',
    messageId: m.id,
    receivedAt: m.receivedAt?.getTime() ?? Date.now(),
  };
}
