/**
 * Drizzle schema — SQLite. Encodes the locked design decisions:
 *  - Internal UUID primary keys (NOT IMAP UID, NOT Message-ID) — ARCHITECTURE cross-cutting.
 *  - message_id / gm_msgid / thread_id stored for dedup + threading.
 *  - Folders/labels modelled many-to-many via message_folders — ARCHITECTURE §8.
 *  - Attachments are metadata-only until lazily downloaded (storagePath nullable) — §4.
 *  - Everything scoped by accountId for multi-account support.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const uuid = () => text('id').primaryKey().$defaultFn(randomUUID);
const now = () =>
  integer('created_at', { mode: 'timestamp_ms' }).default(sql`(unixepoch() * 1000)`);

/** Connected mail accounts. Credentials are NOT stored here — they live in env (ARCHITECTURE §5). */
export const accounts = sqliteTable('accounts', {
  id: uuid(),
  email: text('email').notNull(),
  displayName: text('display_name'),
  provider: text('provider', { enum: ['gmail', 'imap'] }).notNull(),
  imapHost: text('imap_host').notNull(),
  imapPort: integer('imap_port').notNull().default(993),
  smtpHost: text('smtp_host').notNull(),
  smtpPort: integer('smtp_port').notNull().default(465),
  /** Last known HIGHESTMODSEQ for CONDSTORE/QRESYNC resync (null on Gmail / unsupported). */
  lastModseq: integer('last_modseq'),
  createdAt: now(),
});

/** Folders / labels. Scoped per account. */
export const folders = sqliteTable(
  'folders',
  {
    id: uuid(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    name: text('name').notNull(),
    role: text('role', {
      enum: ['inbox', 'sent', 'drafts', 'archive', 'trash', 'junk', 'custom'],
    })
      .notNull()
      .default('custom'),
    /** IMAP UIDVALIDITY — if the server changes this, cached UIDs for the folder are invalid. */
    uidValidity: integer('uid_validity'),
    /** Highest MODSEQ seen (CONDSTORE/QRESYNC) — resync flags via `changedSince`. Null if unsupported. */
    highestModseq: integer('highest_modseq'),
    /** UIDNEXT at last sync — new messages are fetched from `lastUid:*` on resync. */
    lastUid: integer('last_uid'),
    createdAt: now(),
  },
  (t) => [uniqueIndex('folders_account_path_uq').on(t.accountId, t.path)],
);

/** Messages — internal UUID identity; message_id/gm_msgid for dedup; thread_id for conversations. */
export const messages = sqliteTable(
  'messages',
  {
    id: uuid(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** RFC Message-ID header — indexed, nullable, NON-unique (sender-controlled). Dedup only. */
    messageId: text('message_id'),
    /** Gmail X-GM-MSGID — stable account-unique id, stronger dedup key when present. */
    gmMsgId: text('gm_msgid'),
    /** Conversation id (Gmail X-GM-THRID, or internally derived from References/In-Reply-To). */
    threadId: text('thread_id'),
    /** Header chain kept raw so out-of-order threading is back-fillable (ARCHITECTURE §11). */
    inReplyTo: text('in_reply_to'),
    references: text('references'),
    subject: text('subject'),
    fromName: text('from_name'),
    fromAddress: text('from_address'),
    /** JSON-encoded EmailAddress[] of the original To/Cc — drives reply-all. */
    toAddresses: text('to_addresses'),
    ccAddresses: text('cc_addresses'),
    snippet: text('snippet'),
    bodyText: text('body_text'),
    bodyHtml: text('body_html'),
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }),
    receivedAt: integer('received_at', { mode: 'timestamp_ms' }),
    seen: integer('seen', { mode: 'boolean' }).notNull().default(false),
    flagged: integer('flagged', { mode: 'boolean' }).notNull().default(false),
    answered: integer('answered', { mode: 'boolean' }).notNull().default(false),
    draft: integer('draft', { mode: 'boolean' }).notNull().default(false),
    /**
     * Soft-delete / tombstone timestamp (ARCHITECTURE §13). Non-null ⇒ trashed:
     * filtered out of every list/search view, but the row survives so
     * `/m/:internalUUID` deep links never 404. Cleared when the message is re-sighted
     * in a NON-trash folder on resync (undelete / move-race convergence — see store.ts).
     */
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    createdAt: now(),
  },
  (t) => [
    index('messages_account_idx').on(t.accountId),
    index('messages_message_id_idx').on(t.messageId),
    index('messages_gm_msgid_idx').on(t.gmMsgId),
    index('messages_thread_idx').on(t.threadId),
    index('messages_received_idx').on(t.receivedAt),
  ],
);

/** Many-to-many message<->folder mapping. Holds the per-folder IMAP UID. */
export const messageFolders = sqliteTable(
  'message_folders',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    /** IMAP UID is unique only within (folder, uidvalidity) — never use it as a global key. */
    uid: integer('uid'),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.folderId] }),
    index('message_folders_folder_uid_idx').on(t.folderId, t.uid),
  ],
);

/** Browser Web Push subscriptions (VAPID) for background notifications (ARCHITECTURE §3). */
export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: uuid(),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  createdAt: now(),
});

/** Attachment metadata. storagePath is null until the bytes are lazily fetched (ARCHITECTURE §4). */
export const attachments = sqliteTable(
  'attachments',
  {
    id: uuid(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    filename: text('filename'),
    mimeType: text('mime_type'),
    sizeBytes: integer('size_bytes'),
    /** IMAP body part id used to fetch the bytes on demand. */
    imapPartId: text('imap_part_id'),
    /** Content-ID for inline (CID) images. */
    contentId: text('content_id'),
    isInline: integer('is_inline', { mode: 'boolean' }).notNull().default(false),
    /** Local path once downloaded; null = not yet fetched. */
    storagePath: text('storage_path'),
    downloadedAt: integer('downloaded_at', { mode: 'timestamp_ms' }),
    createdAt: now(),
  },
  (t) => [index('attachments_message_idx').on(t.messageId)],
);
