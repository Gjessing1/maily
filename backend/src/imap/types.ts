/**
 * Internal sync-pipeline shapes (backend-only — not the wire DTOs in `shared/`).
 * A `ParsedMessage` is the provider-agnostic result of parsing one IMAP message,
 * ready to be persisted by the store.
 */
import type { EmailAddress } from '@maily/shared';

export interface MessageFlags {
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
}

export interface ParsedAttachment {
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  /** IMAP BODYSTRUCTURE part id used to fetch the bytes on demand (ARCHITECTURE §4). */
  imapPartId: string | null;
  /** Document-order index among attachment parts — local-source match key (§3.7.E). */
  partOrdinal: number;
  contentId: string | null;
  isInline: boolean;
}

export interface ParsedMessage {
  /** RFC Message-ID (sender-controlled) — dedup only, never the primary key. */
  messageId: string | null;
  /** Gmail X-GM-MSGID — stronger account-unique dedup key when present. */
  gmMsgId: string | null;
  /** Provider thread id (Gmail X-GM-THRID). Null on non-Gmail; we derive one instead. */
  providerThreadId: string | null;
  inReplyTo: string | null;
  /** Raw References header value (space-separated Message-IDs), kept for back-fill. */
  references: string | null;
  subject: string | null;
  fromName: string | null;
  fromAddress: string | null;
  /** Original To/Cc recipients (from the IMAP envelope) — persisted for reply-all. */
  to: EmailAddress[];
  cc: EmailAddress[];
  snippet: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  /** Captured iCalendar (text/calendar) part for a calendar invite; null when absent. */
  bodyCalendar: string | null;
  /** On-disk raw `.eml` path when captured on the live path; null until archived (§3.7.E). */
  sourcePath: string | null;
  sentAt: Date | null;
  receivedAt: Date | null;
  flags: MessageFlags;
  attachments: ParsedAttachment[];
}
