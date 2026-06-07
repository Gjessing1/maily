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
    /**
     * Low-watermark of the resumable full-source sweep (ROADMAP §3.7.E): the lowest
     * UID whose raw `.eml` has been archived. The sweep walks downward from here, so
     * an interrupted run resumes instead of restarting. Null = sweep not yet started.
     */
    oldestSyncedUid: integer('oldest_synced_uid'),
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
    /**
     * Captured iCalendar (text/calendar) part, when the message carries one — a
     * calendar invite's small inline VEVENT block (ARCHITECTURE §4 eager exception).
     * Null = no calendar part. Input to the deterministic ICS enricher; not in FTS.
     */
    bodyCalendar: text('body_calendar'),
    /**
     * On-disk path of the complete raw RFC822 (.eml) — the canonical content store
     * (ROADMAP §3.7.E / ARCHITECTURE §15). Null = not yet archived; the parsed
     * columns above are then the message's only copy. Once set, the parsed rows /
     * FTS / attachment bytes are a rebuildable cache over this file.
     */
    sourcePath: text('source_path'),
    /**
     * Size in bytes of the on-disk raw `.eml` (`source_path`), captured at archive
     * time. Null until the message is archived (or for rows archived before this
     * column existed — healed by the source-bytes backfill). The dominant true byte
     * cost of a message, so the cleanup storage metric adds it to body+attachment
     * sizes for the real total (slices.ts `BYTES`).
     */
    sourceBytes: integer('source_bytes'),
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

/**
 * Contacts cached from the Radicale CardDAV addressbook (ROADMAP §3.7.D). One row
 * per (card, email) so an address autocompletes directly; `vcardUid` ties the rows
 * of a multi-email card together. The whole table is a rebuildable cache of the
 * remote addressbook — refreshed by a periodic sync, never the source of truth.
 */
export const contacts = sqliteTable(
  'contacts',
  {
    id: uuid(),
    /** Lowercased email address — the autocomplete + sender-enrichment key. */
    email: text('email').notNull(),
    /** Formatted name (vCard FN), if the card carries one. */
    name: text('name'),
    /** vCard UID — stable per card across syncs; groups a card's multiple emails. */
    vcardUid: text('vcard_uid'),
    /** Card's CardDAV resource path (relative to server origin) — for PUT/DELETE. */
    href: text('href'),
    /** Card's getetag — sent as If-Match on update to detect concurrent edits. */
    etag: text('etag'),
    /**
     * CardDAV collection (address book) the card belongs to — its href. Multi-address-book
     * support (ROADMAP §C, contacts Phase 1). Null for pre-sync/legacy rows; repopulated
     * on the next sync (the table is a rebuildable cache).
     */
    addressbookHref: text('addressbook_href'),
    /** The book's display name captured at sync time (labelling without a live PROPFIND). */
    addressbookName: text('addressbook_name'),
    /**
     * The card's full raw vCard text (contacts Phase 2). Stored verbatim per email-row
     * (same across a card's rows) so rich fields can be parsed for display and, on edit,
     * merged back while preserving properties maily doesn't model (PHOTO, X-* extensions).
     * Radicale stays the source of truth; this is a rebuildable cache. NULL for legacy rows.
     */
    rawVcard: text('raw_vcard'),
    createdAt: now(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).default(sql`(unixepoch() * 1000)`),
  },
  (t) => [uniqueIndex('contacts_email_uq').on(t.email), index('contacts_name_idx').on(t.name)],
);

/**
 * Single-user app settings — the source of truth for UI preferences so they sync
 * across every device/browser instead of living only in each client's localStorage
 * (ARCHITECTURE §5: never secrets, only display prefs). Key-value with a JSON blob;
 * the whole prefs object is stored under one well-known key ('prefs').
 */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).default(sql`(unixepoch() * 1000)`),
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
    /**
     * Stable document-order index assigned during the BODYSTRUCTURE walk
     * (`extractStructure`, DFS order). The local-source resolver selects the matching
     * MIME part by walking the `.eml` in the same order with the same classifier, so
     * the match is exact regardless of duplicate filenames/sizes (ROADMAP §3.7.E).
     */
    partOrdinal: integer('part_ordinal'),
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

/**
 * Enrichment-pipeline ledger (Phase 4; ARCHITECTURE §14/§15 — the `enriched` stage).
 * ONE row per (message, enricher), serving three roles at once:
 *  - work queue:   status='pending' + nextAttemptAt gate the runner's claim scan;
 *  - result store: status='ok' rows carry the enricher output JSON in `result`;
 *  - dead-letter:  status='dead' = a poison message that exhausted its retries.
 * A rebuildable projection over messages (drop + re-run with zero IMAP refetch).
 * Observability (duration, failure reason, version applied, queue depth) is all
 * derivable from this single table.
 */
export const enrichments = sqliteTable(
  'enrichments',
  {
    id: uuid(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    /** Registered enricher name (stable key; pairs with `enricherVersion`). */
    enricher: text('enricher').notNull(),
    /** Enricher version at (last) run — a bump marks rows stale + eligible for re-run. */
    enricherVersion: integer('enricher_version').notNull(),
    /** Classification driving tiering/ordering (ARCHITECTURE §14). */
    kind: text('kind', { enum: ['operational', 'search', 'analytical'] }).notNull(),
    /**
     * Scheduling cost (ROADMAP Phase 5): 'cheap' deterministic vs 'llm' Ollama work.
     * Lets the claim scan filter by cost so a deep LLM backlog never starves cheap mail
     * or monopolises the worker. Existing rows default to 'cheap' (all deterministic).
     */
    cost: text('cost', { enum: ['cheap', 'llm'] })
      .notNull()
      .default('cheap'),
    status: text('status', { enum: ['pending', 'ok', 'failed', 'dead'] })
      .notNull()
      .default('pending'),
    /** Retry counter; at the configured cap a failed row is parked as 'dead'. */
    attempts: integer('attempts').notNull().default(0),
    /** Backoff gate (ms): a pending row is only claimed once now >= nextAttemptAt. */
    nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp_ms' }),
    /** JSON enricher output (search tokens / extracted facts); null unless status='ok'. */
    result: text('result'),
    /** Last failure reason (null on success). */
    error: text('error'),
    /** Last run duration (observability). */
    durationMs: integer('duration_ms'),
    createdAt: now(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex('enrichments_message_enricher_uq').on(t.messageId, t.enricher),
    index('enrichments_status_due_idx').on(t.status, t.nextAttemptAt),
    // Cost-scoped claim scan (Phase 5): drain cheap work fully, LLM work in bounded batches.
    index('enrichments_cost_status_due_idx').on(t.cost, t.status, t.nextAttemptAt),
    index('enrichments_enricher_version_idx').on(t.enricher, t.enricherVersion),
  ],
);

/**
 * Proposals — the `derived` stage (ARCHITECTURE §15). An *offer* attached to a source
 * message (add-to-calendar, track-package, …), surfaced later by the Action Center.
 * Un-acted proposals silently expire (`expiresAt`) rather than piling into a second
 * inbox (ROADMAP Phase 4 anti-chore guardrail). A rebuildable projection like enrichments.
 */
export const proposals = sqliteTable(
  'proposals',
  {
    id: uuid(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    /** Enricher that produced this proposal (provenance). */
    enricher: text('enricher').notNull(),
    /** Proposal kind, e.g. 'calendar_event' | 'package_track' (enricher-defined). */
    type: text('type').notNull(),
    /** Human-readable label for the action chip / list row. */
    title: text('title'),
    /** JSON detail the approve-flow acts on (e.g. a VEVENT, a tracking URL). */
    payload: text('payload'),
    status: text('status', { enum: ['pending', 'approved', 'dismissed', 'expired'] })
      .notNull()
      .default('pending'),
    /** Horizon-bounded silent expiry — an ignored offer ages out without nagging. */
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    createdAt: now(),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('proposals_status_idx').on(t.status),
    index('proposals_message_idx').on(t.messageId),
  ],
);

/**
 * Cleanup trash queue (ROADMAP Phase 6b — execution path). ONE row per message awaiting
 * a rate-limited MOVE-to-Trash, modelled on the `enrichments`-as-queue pattern: a pending
 * row with `nextAttemptAt` is claimed by the trickle runner, MOVEd to the account's Trash
 * folder, then marked `done`. Trash-only by design — the runner never EXPUNGEs, so moving
 * to Trash *is* the archive-before-delete staging (recoverable, nothing hard-deleted in one
 * step). The local tombstone (`messages.deletedAt`) is set up front by the execute endpoint;
 * this table only tracks the outstanding server-side IMAP work so it survives a restart.
 */
export const cleanupQueue = sqliteTable(
  'cleanup_queue',
  {
    id: uuid(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    /** Denormalised for per-account batching without a join in the runner's hot path. */
    accountId: text('account_id').notNull(),
    /** Provenance — which slice queued this message ('never-replied' | 'cold-storage'). */
    slice: text('slice').notNull(),
    status: text('status', { enum: ['pending', 'done', 'failed', 'dead'] })
      .notNull()
      .default('pending'),
    /** Retry counter; at the cap a failed row is parked as 'dead'. */
    attempts: integer('attempts').notNull().default(0),
    /** Backoff gate (ms): a pending row is only claimed once now >= nextAttemptAt. */
    nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp_ms' }),
    /** Last failure reason (null on success). */
    error: text('error'),
    createdAt: now(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex('cleanup_queue_message_uq').on(t.messageId),
    index('cleanup_queue_status_due_idx').on(t.status, t.nextAttemptAt),
  ],
);
