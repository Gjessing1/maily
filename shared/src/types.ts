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
  /** Primary To recipients — drives recipient display in outgoing folders (Sent). */
  to: EmailAddress[];
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

/** A labelled value (phone/website) — the optional label is Home/Work/Cell/etc. */
export interface TypedValueDto {
  type: string | null;
  value: string;
}

/** A structured postal address (vCard ADR); PO-box/extended slots are not modelled. */
export interface ContactAddressDto {
  type: string | null;
  street: string;
  locality: string;
  region: string;
  postalCode: string;
  country: string;
}

/** A whole CardDAV card (one vCard) as listed/edited in the Contacts manager. */
export interface ContactCardDto {
  /** vCard UID — stable identity used to update/delete the card. */
  uid: string;
  /** Formatted display name (vCard FN). */
  name: string | null;
  /** All email addresses on the card, in card order. */
  emails: string[];
  /** Href of the address book this card lives in (null for pre-sync/legacy rows). */
  addressbook: string | null;
  /** Rich fields (contacts Phase 2), parsed from the card's raw vCard. */
  nickname: string | null;
  /** Company / organisation (first ORG component). */
  org: string | null;
  /** Job title / role (vCard TITLE). */
  title: string | null;
  phones: TypedValueDto[];
  urls: TypedValueDto[];
  addresses: ContactAddressDto[];
  /** Birthday, as stored (ISO `YYYY-MM-DD` or a free-form vCard date). */
  birthday: string | null;
  note: string | null;
  categories: string[];
  /** Renderable avatar source (data: URI or external URL) parsed from PHOTO, if any. */
  photo: string | null;
}

/**
 * Create/update payload for a contact card (UID assigned server-side on create).
 * The rich fields are optional so a minimal name+emails payload still works; omitted
 * fields are treated as empty. PHOTO and unmodelled properties are preserved server-side.
 */
export interface ContactCardInput {
  name: string | null;
  emails: string[];
  /** Target address book href on create; omitted/null uses the configured default. */
  addressbook?: string | null;
  nickname?: string | null;
  org?: string | null;
  title?: string | null;
  phones?: TypedValueDto[];
  urls?: TypedValueDto[];
  addresses?: ContactAddressDto[];
  birthday?: string | null;
  note?: string | null;
  categories?: string[];
}

/** Outcome of a vCard import: how many cards were created vs. skipped. */
export interface ContactImportResult {
  /** Cards successfully PUT to the address book. */
  imported: number;
  /** Cards skipped (no email / unparseable / write failed). */
  skipped: number;
}

/** One discovered CardDAV address book (collection). */
export interface AddressbookDto {
  /** Collection href — the stable id used to target/filter a book. */
  href: string;
  /** Human-readable book name (CardDAV displayname, or the last path segment). */
  displayName: string;
}

/** Discovered books + which are active (synced/in use) and the default create target. */
export interface AddressbookSettingsDto {
  books: AddressbookDto[];
  /** Hrefs of the books currently synced into the contacts cache. */
  active: string[];
  /** Href of the book new contacts are created in, or null when none. */
  default: string | null;
}

/** One discovered CalDAV calendar (collection). */
export interface CalendarDto {
  /** Collection href — the stable id used to target a calendar. */
  href: string;
  /** Human-readable calendar name (CalDAV displayname, or the last path segment). */
  displayName: string;
}

/** Discovered calendars + the default target for new events. */
export interface CalendarSettingsDto {
  calendars: CalendarDto[];
  /** Href of the calendar new events land in, or null when none discovered. */
  default: string | null;
}

/**
 * A suggested calendar event extracted from a message — pre-fill for the
 * "Add to calendar" form. VEVENT-shaped (one representation, ARCHITECTURE §14).
 */
export interface EventDraftDto {
  summary: string;
  /** ISO 8601: date-only = all-day; trailing Z/offset = zoned; bare = floating. */
  start: string | null;
  end: string | null;
  location: string | null;
  description: string | null;
  /** What produced the suggestion (invite/travel enricher, or the bare message). */
  source: 'invite' | 'flight' | 'lodging' | 'event' | 'message';
}

/** User-confirmed event to write to the calendar (CalDAV PUT). */
export interface CalendarEventInput {
  /** Target calendar href; the server default when omitted. */
  calendar?: string | null;
  summary: string;
  /** ISO 8601 — date-only for all-day, else a (floating) local date-time. */
  start: string;
  end?: string | null;
  location?: string | null;
  description?: string | null;
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
  /**
   * Estimated bytes of synced content for this account: stored message bodies plus
   * attachments actually downloaded to disk. A cheap estimate for Settings → Sync
   * (the raw .eml archive isn't counted — it has no stored size).
   */
  contentBytes: number;
  folders: FolderSyncStatusDto[];
}

/** Non-secret server configuration surfaced to the client (Settings). */
export interface ServerConfigDto {
  /** Backend `MAILY_CACHE_WINDOW_DAYS`: days of mail synced into the local SQLite cache. */
  cacheWindowDays: number;
}

/** Row counts for one slice of the enrichment ledger (Settings → Enrichment). */
export interface EnrichmentCounts {
  /** All ledger rows in this slice (done + pending + failed + dead). */
  total: number;
  /** Successfully enriched rows (status `ok`). */
  done: number;
  /** Rows never attempted yet (status `pending`). */
  pending: number;
  /** Rows that errored and are awaiting a backoff retry (status `failed`). */
  failed: number;
  /** Rows that exhausted retries and were parked (status `dead`). */
  dead: number;
}

/**
 * The item the worker is generating right now. Only LLM (Ollama) enrichment takes
 * multiple seconds, so it's the only work surfaced as "current"; cheap deterministic
 * enrichers finish sub-millisecond. Ephemeral (lost on restart) — a live signal, not state.
 */
export interface CurrentEnrichmentDto {
  /** Enricher name running now (e.g. `summary`). */
  enricher: string;
  /** Subject of the message being enriched, best-effort label for the UI. */
  subject: string | null;
  /** Epoch ms this item started generating. */
  since: number;
}

/** Enrichment-pipeline progress for Settings (shown alongside Sync stats). */
export interface EnrichmentStatusDto {
  /** True when the LLM (Ollama) enricher is configured and registered. */
  llmEnabled: boolean;
  /** Configured Ollama model id when `llmEnabled`, else null. */
  model: string | null;
  /** Counts across every enricher (cheap + LLM). */
  overall: EnrichmentCounts;
  /** Counts for LLM-cost enrichers only — the slow Ollama backlog the user cares about. */
  llm: EnrichmentCounts;
  /** What's generating right now, or null when idle. */
  current: CurrentEnrichmentDto | null;
}

/**
 * One row of a cleanup slice — a sender with its preview impact (ROADMAP Phase 6
 * Cleanup Dashboard). Grouping by sender is what lets a preset say "delete N from
 * <sender>, free X" before any execution.
 */
export interface CleanupGroupDto {
  /**
   * The sender key (lowercased): the sender's domain, except freemail/consumer providers
   * (gmail, hotmail, …) which key by full address — one "gmail.com" bucket would lump
   * thousands of unrelated people into a single fake sender. '(unknown)' when the
   * address has no domain. Round-trips as the `domain` scope on drill-down and execute.
   */
  domain: string;
  messageCount: number;
  /** Estimated bytes: parsed body (text+html) + attachment sizes. */
  bytes: number;
  /** Oldest / newest message in the group (ISO), null if unknown. */
  oldestAt: string | null;
  newestAt: string | null;
}

/**
 * A deterministic cleanup slice with its preview impact (count + estimated storage),
 * grouped by sender key. Read-only analytics — the destructive execution path is
 * separate. `groups` is capped to the worst offenders; `truncated` flags more below.
 */
export interface CleanupSliceDto {
  /** Slice id: 'storage' | 'never-replied' | 'cold-storage' | 'large' | 'unread' | 'newsletters'. */
  slice: string;
  groups: CleanupGroupDto[];
  totalMessages: number;
  totalBytes: number;
  truncated: boolean;
}

/**
 * One message inside a cleanup slice — the drill-down unit (ROADMAP Phase 6b). Lets the
 * user inspect exactly what a slice/sender would trash before confirming; `id` deep-links
 * to the reader (the internal UUID, never the IMAP UID — see CLAUDE.md gotchas).
 */
export interface CleanupMessageDto {
  id: string;
  subject: string | null;
  fromName: string | null;
  fromAddress: string | null;
  /** Received timestamp (ISO), or null if unknown. */
  receivedAt: string | null;
  /** Estimated bytes (same per-message estimate as the slice totals). */
  bytes: number;
}

/**
 * Drill-down of a delete-eligible slice to individual messages, optionally scoped to one
 * sender key. Re-runs the SAME safety + slice predicates as the preview/execute paths,
 * so what's listed is exactly what would be trashed. `messages` is capped at `limit`;
 * `truncated` flags that `total` exceeds what's returned.
 */
export interface CleanupMessagesDto {
  slice: string;
  /** Sender key this drill-down is scoped to, or null for the whole slice. */
  domain: string | null;
  messages: CleanupMessageDto[];
  /** Total matching messages (before the `limit` cap). */
  total: number;
  /** Estimated bytes of ALL matching messages (not just the returned page). */
  totalBytes: number;
  truncated: boolean;
}

/** Cleanup Dashboard headline figures. */
export interface CleanupSummaryDto {
  totalMessages: number;
  totalBytes: number;
  /** Messages caught by the HARD safety filter (protected from any cleanup). */
  protectedMessages: number;
  /** Messages cleanup has moved to Trash so far (the "freed so far" tally). */
  trashedMessages: number;
  /** Estimated bytes those trashed messages were occupying. */
  trashedBytes: number;
}

/**
 * The whole Cleanup Dashboard in one response: headline summary, trash-queue progress and
 * the first page of every slice. One round-trip instead of seven, served from the backend's
 * precomputed cache so entering the dashboard is instant.
 */
export interface CleanupDashboardDto {
  summary: CleanupSummaryDto;
  queue: CleanupQueueStatusDto;
  storage: CleanupSliceDto;
  neverReplied: CleanupSliceDto;
  coldStorage: CleanupSliceDto;
  large: CleanupSliceDto;
  unread: CleanupSliceDto;
  newsletters: CleanupSliceDto;
}

/**
 * Execute a delete-eligible cleanup slice (ROADMAP Phase 6b). The server always re-resolves
 * the slice and re-applies the HARD safety gate at execution time, then **intersects** that
 * eligible set with whatever scope the client sends — so a forged/stale/protected id can never
 * be trashed (it simply isn't in the eligible set). Scope precedence: `messageIds` (explicit
 * selection) and/or `domain` (single sender) narrow the set; `excludeDomains` spares senders
 * from the whole-slice "Clean all" path. Sending none of them targets the entire slice.
 */
export interface CleanupExecuteRequest {
  slice: 'never-replied' | 'cold-storage' | 'large' | 'unread' | 'newsletters';
  /** Cold-storage age threshold (years); ignored for other slices. */
  years?: number;
  /** Large-message size threshold (MB); ignored for other slices. */
  minMb?: number;
  /** Unread-and-old age threshold (months); ignored for other slices. */
  months?: number;
  /** Explicit message selection — only these ids (∩ the eligible set) are trashed. */
  messageIds?: string[];
  /** Restrict to a single sender key (lowercased) — "trash all from this sender". */
  domain?: string;
  /** Sender keys to spare from a whole-slice run (lowercased). */
  excludeDomains?: string[];
  /** Message ids to spare — the "select all, uncheck a few" drill-down path. */
  excludeMessageIds?: string[];
}

/** Result of queuing a cleanup execution — how many messages were enqueued for trashing. */
export interface CleanupExecuteResultDto {
  slice: string;
  queued: number;
}

/**
 * Set/clear the per-message "preserve from cleanup" flag (migration 0019). A preserved message
 * is excluded from every delete-eligible slice — the user's per-message counterpart of the HARD
 * keyword safety gate, for mail the heuristics can't recognise as worth keeping.
 */
export interface CleanupKeepRequest {
  messageIds: string[];
  /** true ⇒ preserve (exclude from cleanup); false ⇒ release back into the slices. */
  keep: boolean;
}

/** Result of a preserve-from-cleanup toggle — how many message rows changed. */
export interface CleanupKeepResultDto {
  updated: number;
}

/** Trash-queue progress for the dashboard. `failed` = rows that exhausted their retries. */
export interface CleanupQueueStatusDto {
  pending: number;
  failed: number;
  done: number;
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
  | { type: 'sync:progress'; accountId: string; done: number; total: number };
