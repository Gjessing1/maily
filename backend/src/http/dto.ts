/**
 * Map internal DB rows to the wire DTOs in `shared/`. Never leak credentials,
 * IMAP UIDs, or raw header chains the client doesn't need.
 */
import type {
  AccountDto,
  AttachmentDto,
  FolderDto,
  MessageDetailDto,
  MessageDto,
  Provider,
} from '@maily/shared';
import type { accounts, folders } from '../db/schema.js';
import type { AttachmentRow, MessageRow } from '../db/queries.js';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toAccountDto(a: typeof accounts.$inferSelect): AccountDto {
  return {
    id: a.id,
    email: a.email,
    displayName: a.displayName,
    provider: a.provider as Provider,
  };
}

export function toFolderDto(f: typeof folders.$inferSelect): FolderDto {
  return { id: f.id, accountId: f.accountId, path: f.path, name: f.name, role: f.role };
}

export function toAttachmentDto(a: AttachmentRow): AttachmentDto {
  return {
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    isInline: a.isInline,
    downloaded: a.storagePath !== null,
  };
}

export function toMessageDto(
  m: MessageRow,
  folderIds: string[],
  attachmentRows: AttachmentRow[],
): MessageDto {
  return {
    id: m.id,
    accountId: m.accountId,
    threadId: m.threadId,
    subject: m.subject,
    fromName: m.fromName,
    fromAddress: m.fromAddress,
    snippet: m.snippet,
    sentAt: iso(m.sentAt),
    receivedAt: iso(m.receivedAt),
    seen: m.seen,
    flagged: m.flagged,
    folderIds,
    attachments: attachmentRows.map(toAttachmentDto),
  };
}

export function toMessageDetailDto(
  m: MessageRow,
  folderIds: string[],
  attachmentRows: AttachmentRow[],
): MessageDetailDto {
  return {
    ...toMessageDto(m, folderIds, attachmentRows),
    bodyText: m.bodyText,
    bodyHtml: m.bodyHtml,
    inReplyTo: m.inReplyTo,
    references: m.references,
  };
}
