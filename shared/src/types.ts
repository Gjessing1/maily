/**
 * Types shared between the backend API and the React PWA.
 * Keep these provider-agnostic; provider-specific quirks live in the backend.
 */

/** Upstream mail provider family. Drives capability-dependent behaviour. */
export type Provider = 'gmail' | 'imap';

/** Well-known special-use folder roles (IMAP SPECIAL-USE / Gmail labels). */
export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'archive' | 'trash' | 'junk' | 'custom';

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

/** Lightweight signals pushed over Socket.io (never heavy payloads — see ARCHITECTURE §3). */
export type SocketSignal =
  | { type: 'mail:new'; accountId: string; messageId: string }
  | { type: 'mail:flags'; accountId: string; messageId: string; seen: boolean; flagged: boolean }
  | { type: 'sync:progress'; accountId: string; done: number; total: number }
  | { type: 'action:ready'; messageId: string; label: string };
