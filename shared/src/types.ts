/**
 * Types shared between the backend API and the React PWA.
 * Keep these provider-agnostic; provider-specific quirks live in the backend.
 */

/** Upstream mail provider family. Drives capability-dependent behaviour. */
export type Provider = 'gmail' | 'imap';

/** Well-known special-use folder roles (IMAP SPECIAL-USE / Gmail labels). */
export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'archive' | 'trash' | 'junk' | 'custom';

/** A parsed mail address (display name optional). */
export interface EmailAddress {
  name: string | null;
  address: string;
}

/** A connected mail account (credentials are NOT part of this DTO — they live in env). */
export interface AccountDto {
  id: string;
  email: string;
  displayName: string | null;
  provider: Provider;
}

/** A folder/label within an account. */
export interface FolderDto {
  id: string;
  accountId: string;
  path: string;
  name: string;
  role: FolderRole;
}

/** Attachment metadata. `downloaded` is false until the bytes are lazily fetched. */
export interface AttachmentDto {
  id: string;
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  isInline: boolean;
  downloaded: boolean;
}

/** A message as exposed to the client. Body fields may be omitted in list views. */
export interface MessageDto {
  id: string;
  accountId: string;
  threadId: string | null;
  subject: string | null;
  fromName: string | null;
  fromAddress: string | null;
  snippet: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  seen: boolean;
  flagged: boolean;
  folderIds: string[];
  attachments: AttachmentDto[];
}

/** Full message including body — returned by the read-one endpoint (not list views). */
export interface MessageDetailDto extends MessageDto {
  /** This message's own RFC Message-ID header (for setting In-Reply-To on replies). */
  messageId: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  inReplyTo: string | null;
  references: string | null;
  /** Original To/Cc recipients — drives reply-all (empty for older pre-migration mail). */
  to: EmailAddress[];
  cc: EmailAddress[];
}

/** Reference to an existing stored attachment, re-sent by the backend (e.g. on forward). */
export interface AttachmentRef {
  messageId: string;
  attachmentId: string;
}

/** A freshly uploaded outbound attachment, staged on the backend before sending. */
export interface UploadDto {
  uploadId: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number;
}

/** Reference to a staged upload, attached to an outgoing message by `uploadId`. */
export interface UploadRef {
  uploadId: string;
  filename: string;
  mimeType?: string | null;
}

/** Outgoing message composed by the client and sent via the backend (SMTP). */
export interface SendMessageRequest {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  /** Message-ID being replied to (sets In-Reply-To/References for threading). */
  inReplyTo?: string | null;
  references?: string | null;
  /** Existing attachments to re-attach (forward): backend resolves bytes from cache/IMAP. */
  attachments?: AttachmentRef[];
  /** Freshly uploaded files (composer): backend resolves bytes from the uploads staging dir. */
  uploads?: UploadRef[];
  /**
   * The internal id of a saved draft this message supersedes. When sending an
   * edited draft, the backend removes that draft copy from \Drafts after a
   * successful send so it doesn't linger. Ignored when absent.
   */
  replaceDraftId?: string | null;
}

/**
 * Save (or update) a draft: same shape as a send, minus the SMTP step. The backend
 * APPENDs the composed MIME to the account's \Drafts mailbox (ROADMAP §B), so drafts
 * sync across devices instead of living only in the composer. `replaceDraftId` swaps
 * a previously-saved copy (edit-in-place) rather than accumulating duplicates.
 */
export type SaveDraftRequest = SendMessageRequest;

/** Result of saving a draft. */
export interface SaveDraftResult {
  /** RFC Message-ID of the appended draft. */
  messageId: string;
  /** False when the account has no \Drafts mailbox to APPEND into. */
  savedToDrafts: boolean;
}

/** A contact from the cached CardDAV addressbook — drives compose autocomplete. */
export interface ContactDto {
  name: string | null;
  email: string;
}

/** A whole CardDAV card (one vCard) as listed/edited in the Contacts manager. */
export interface ContactCardDto {
  /** vCard UID — stable identity used to update/delete the card. */
  uid: string;
  /** Formatted display name (vCard FN). */
  name: string | null;
  /** All email addresses on the card, in card order. */
  emails: string[];
}

/** Create/update payload for a contact card (UID assigned server-side on create). */
export interface ContactCardInput {
  name: string | null;
  emails: string[];
}

/** Per-folder cached sync state for the Settings → Sync view. */
export interface FolderSyncStatusDto {
  id: string;
  name: string;
  role: string;
  /** Non-tombstoned messages cached locally for this folder. */
  cached: number;
  /** Whether the folder has completed at least one sync pass (uid_validity set). */
  synced: boolean;
}

/** Per-account sync status (connection + last activity + folder counts). */
export interface AccountSyncStatusDto {
  accountId: string;
  email: string;
  provider: string;
  /** Live IMAP IDLE connection currently up. */
  connected: boolean;
  /** Epoch ms of the last completed resync pass, or null if none yet this run. */
  lastSyncAt: number | null;
  folders: FolderSyncStatusDto[];
}

/** Non-secret server configuration surfaced to the client (Settings). */
export interface ServerConfigDto {
  /** Backend `MAILY_CACHE_WINDOW_DAYS`: days of mail synced into the local SQLite cache. */
  cacheWindowDays: number;
}

/** A browser Web Push subscription, registered by the PWA for background notifications. */
export interface PushSubscriptionDto {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Lightweight signals pushed over Socket.io (never heavy payloads — see ARCHITECTURE §3). */
export type SocketSignal =
  | { type: 'mail:new'; accountId: string; messageId: string }
  | { type: 'mail:flags'; accountId: string; messageId: string; seen: boolean; flagged: boolean }
  | { type: 'mail:deleted'; accountId: string; messageId: string }
  | { type: 'mail:archived'; accountId: string; messageId: string }
  | { type: 'sync:progress'; accountId: string; done: number; total: number }
  | { type: 'action:ready'; messageId: string; label: string };
