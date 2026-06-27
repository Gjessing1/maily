/**
 * Deterministic cleanup slices (ROADMAP Phase 6 "Master archive & Cleanup Dashboard").
 * Read-only power-user analytics over the local SQLite archive — slices that need no
 * enrichment, each a different *angle* on "what could I be tempted to delete":
 *  - storage audit (informational), senders never replied to, cold-storage candidates,
 *  - large messages (size angle), unread-and-old (attention angle),
 *  - newsletters (bulk-mail angle via the FTS unsubscribe heuristic).
 * Each returns a **preview impact** (message count + an estimated byte total, grouped by
 * sender — domain, or full address for freemail providers, see senders.ts) so the dashboard
 * can always show "delete N, free X" before any execution.
 *
 * Two invariants:
 *  - **Never delete-eligible without the safety gate.** Every destructive slice
 *    AND-s in `notProtected` so financial / legal / account-security / medical mail
 *    (EN+NO) can never surface (ROADMAP HARD RULES).
 *  - **No LIKE-scan.** Keyword matching rides the FTS5 index (ARCHITECTURE §12).
 *
 * This is analytics only — no IMAP, no mutation. Bulk execution (the rate-limited trash
 * queue + archive-before-delete staging) is a separate, later pass.
 */
import { sql, type SQL } from 'drizzle-orm';
import type {
  CleanupGroupDto,
  CleanupMessageDto,
  CleanupSliceDto,
  CleanupSummaryDto,
} from '@maily/shared';
import { db } from '../db/client.js';
import { COLD_KEEP_KEYWORDS, NEWSLETTER_KEYWORDS } from './keywords.js';
import { effectiveKeywords, ftsOrMatch, notProtected, protectedMatch } from './safety.js';
import { SENDER_KEY, senderKeyOf } from './senders.js';

/** Default page size for returned groups per slice — the dashboard shows the worst offenders. */
const GROUP_LIMIT = 50;
/** Default cold-storage age threshold (years). */
const COLD_YEARS = 2;
/** Default large-message size threshold (MB). */
const LARGE_MIN_MB = 10;
/** Default unread-and-old age threshold (months). */
const UNREAD_MONTHS = 12;
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
const MS_PER_MONTH = MS_PER_YEAR / 12;
const MB = 1024 * 1024;

/**
 * Per-message byte estimate. When the message is archived the raw `.eml` size
 * (`source_bytes`, captured at archive time, ROADMAP §3.7.E) is AUTHORITATIVE: the `.eml`
 * already contains the body AND every attachment, so it is the whole on-disk cost — adding
 * the body/attachment terms on top double-counts (~half the headline total once the master
 * archive sweep + lazy attachments landed: the .eml bytes plus a phantom copy of the same
 * attachments). Only a not-yet-archived message (null/0 `source_bytes`) falls back to an
 * estimate from the parsed body (text + html) plus attachment sizes. The body term reads
 * the precomputed `content_bytes` column (migration 0018) — length() over the body columns
 * inside an aggregate forces SQLite to read + decode every body, measured at 15-20s per
 * scan on a real mailbox; the NULL fallback keeps pre-0018 writers correct.
 */
const BYTES = sql`(
  coalesce(nullif(m.source_bytes, 0),
    coalesce(m.content_bytes,
        length(CAST(coalesce(m.body_text, '') AS BLOB)) + length(CAST(coalesce(m.body_html, '') AS BLOB)))
    + coalesce((SELECT SUM(a.size_bytes) FROM attachments a WHERE a.message_id = m.id), 0))
)`;

interface RawGroup {
  domain: string;
  messageCount: number;
  bytes: number | null;
  oldestAt: number | null;
  newestAt: number | null;
}

const iso = (ms: number | null): string | null => (ms != null ? new Date(ms).toISOString() : null);

const toGroup = (r: RawGroup): CleanupGroupDto => ({
  domain: r.domain,
  messageCount: r.messageCount,
  bytes: r.bytes ?? 0,
  oldestAt: iso(r.oldestAt),
  newestAt: iso(r.newestAt),
});

/**
 * Run the grouped storage query for a `WHERE` predicate, returning EVERY sender group
 * (bytes-descending). The group key is {@link SENDER_KEY} — the sender's domain, except
 * freemail/consumer domains (gmail, hotmail, …) which group by full address (one gmail.com
 * bucket would lump thousands of unrelated people into a single fake "sender"). The
 * distinct-key count is small (hundreds–low thousands), so paging and substring search
 * happen in JS via {@link paginateGroups} — that keeps a sender search able to reach the
 * long tail without a body-scanning `LIKE` (ARCHITECTURE §12 forbids those for message
 * search; this is a tiny group-label filter, not an FTS bypass).
 */
function allGroupsByDomain(where: SQL): CleanupGroupDto[] {
  const rows = db.all(
    sql`SELECT ${SENDER_KEY} AS domain,
               COUNT(*) AS messageCount,
               SUM(${BYTES}) AS bytes,
               MIN(m.received_at) AS oldestAt,
               MAX(m.received_at) AS newestAt
        FROM messages m
        WHERE ${where}
        GROUP BY domain
        ORDER BY bytes DESC`,
  ) as RawGroup[];
  return rows.map(toGroup);
}

/** Group-list paging + search options, shared by every slice. */
export interface GroupPageOpts {
  /** Case-insensitive sender-key substring filter (the "Review by sender" search box). */
  q?: string;
  /** Page offset into the (filtered) group list. */
  offset?: number;
  /** Page size; defaults to {@link GROUP_LIMIT}. */
  limit?: number;
}

/**
 * Filter a group list by domain substring (case-insensitive) and return the
 * `[offset, offset+limit)` page. `truncated` means more pages remain past this one — what the
 * dashboard's "Load more" hangs off. Totals are computed by the callers over the *unfiltered*
 * set so the slice headline (and the "Clean all N" express path) always reflect the whole slice.
 */
function paginateGroups(
  groups: CleanupGroupDto[],
  opts: GroupPageOpts = {},
): { groups: CleanupGroupDto[]; truncated: boolean } {
  const q = opts.q?.trim().toLowerCase();
  const filtered = q ? groups.filter((g) => g.domain.includes(q)) : groups;
  const offset = opts.offset && opts.offset > 0 ? opts.offset : 0;
  const limit = opts.limit && opts.limit > 0 ? opts.limit : GROUP_LIMIT;
  return {
    groups: filtered.slice(offset, offset + limit),
    truncated: offset + limit < filtered.length,
  };
}

/** Aggregate totals (count + bytes) for a `WHERE` predicate — the slice headline figures. */
function totalsFor(where: SQL): { totalMessages: number; totalBytes: number } {
  const row = db.get(
    sql`SELECT COUNT(*) AS totalMessages, COALESCE(SUM(${BYTES}), 0) AS totalBytes
        FROM messages m WHERE ${where}`,
  ) as { totalMessages: number; totalBytes: number };
  return { totalMessages: row.totalMessages, totalBytes: row.totalBytes };
}

const LIVE = sql`m.deleted_at IS NULL`;

/**
 * The base predicate of every DELETE-ELIGIBLE slice: live AND not user-preserved.
 * `cleanup_keep` is the per-message "preserve from cleanup" flag (migration 0019) — a
 * user-set counterpart of the keyword safety gate. The informational storage audit and
 * the summary totals deliberately stay on {@link LIVE} (preserved mail still occupies bytes).
 */
const ELIGIBLE = sql`m.deleted_at IS NULL AND m.cleanup_keep = 0`;

/**
 * Full (unpaginated) result of a slice compute — every sender-domain group plus the slice
 * totals (derived from the groups, which partition the slice, so no second table scan).
 * This is the unit the cleanup cache stores; paging/search over it is a cheap JS slice.
 */
export interface SliceData {
  groups: CleanupGroupDto[];
  totalMessages: number;
  totalBytes: number;
}

const dataFromGroups = (groups: CleanupGroupDto[]): SliceData => ({
  groups,
  totalMessages: groups.reduce((n, g) => n + g.messageCount, 0),
  totalBytes: groups.reduce((n, g) => n + g.bytes, 0),
});

/** Page a precomputed {@link SliceData} into the wire DTO (the cache-friendly read path). */
export function paginateSlice(
  slice: string,
  data: SliceData,
  opts: GroupPageOpts = {},
): CleanupSliceDto {
  const { groups, truncated } = paginateGroups(data.groups, opts);
  return {
    slice,
    groups,
    truncated,
    totalMessages: data.totalMessages,
    totalBytes: data.totalBytes,
  };
}

/**
 * Storage audit — every sender domain by estimated bytes. Informational, so NOT
 * safety-filtered (a storage audit shows all mail; it never proposes deletion).
 */
export function storageByDomain(opts: GroupPageOpts = {}): CleanupSliceDto {
  return paginateSlice('storage', computeSliceData('storage'), opts);
}

/**
 * Collect the sender keys the user has ever sent mail to (To + Cc of Sent mail). Keys, not
 * domains: for a freemail recipient the key is the full address, so replying to one gmail
 * friend never excuses every other gmail.com sender from the never-replied slice.
 */
function repliedSenderKeys(): Set<string> {
  const rows = db.all(
    sql`SELECT m.to_addresses AS toA, m.cc_addresses AS ccA
        FROM messages m
        JOIN message_folders mf ON mf.message_id = m.id
        JOIN folders f ON f.id = mf.folder_id
        WHERE f.role = 'sent'`,
  ) as { toA: string | null; ccA: string | null }[];

  const keys = new Set<string>();
  for (const row of rows) {
    for (const json of [row.toA, row.ccA]) {
      if (!json) continue;
      try {
        const list = JSON.parse(json) as { address?: string }[];
        for (const a of list) {
          const key = senderKeyOf(a.address);
          if (key !== '(unknown)') keys.add(key);
        }
      } catch {
        // Tolerate a malformed recipients blob — just skip it.
      }
    }
  }
  return keys;
}

/**
 * Senders never replied to — inbound senders the user has never written back to. A
 * passive bulk-unsubscribe / clutter candidate. Safety-filtered (protected mail excluded)
 * and the '(unknown)' bucket dropped (not actionable). Reply set is computed from Sent.
 */
export function neverRepliedSenders(opts: GroupPageOpts = {}): CleanupSliceDto {
  return paginateSlice('never-replied', computeSliceData('never-replied'), opts);
}

/**
 * The cold-storage predicate: mail older than `years` whose body lacks the value markers
 * (invoice/tax/contract, EN+NO) and which isn't protected. Shared by the preview slice and
 * the execution resolver so both apply the identical safety + keyword + age filter.
 */
function coldStorageWhere(years: number): SQL {
  const cutoff = Date.now() - years * MS_PER_YEAR;
  const coldMatch = ftsOrMatch(effectiveKeywords('cleanupColdKeepKeywords', COLD_KEEP_KEYWORDS));
  return sql`${ELIGIBLE}
    AND m.received_at IS NOT NULL AND m.received_at < ${cutoff}
    AND ${notProtected('m')}
    AND m.id NOT IN (SELECT message_id FROM messages_fts WHERE messages_fts MATCH ${coldMatch})`;
}

/**
 * Cold-storage candidates — mail older than `years` whose body lacks the value markers
 * (invoice/tax/contract, EN+NO) and which isn't protected. The roadmap's deterministic
 * cold heuristic. Safety-filtered (HARD RULE) and keyword-filtered via the FTS index.
 */
export function coldStorageCandidates(
  years = COLD_YEARS,
  opts: GroupPageOpts = {},
): CleanupSliceDto {
  return paginateSlice('cold-storage', computeSliceData('cold-storage', { years }), opts);
}

/**
 * The large-message predicate: estimated size ≥ `minBytes`, not protected. The size
 * angle — a single fat message (usually attachments) is the quickest storage win.
 */
function largeWhere(minBytes: number): SQL {
  return sql`${ELIGIBLE} AND ${notProtected('m')} AND ${BYTES} >= ${minBytes}`;
}

/**
 * The unread-and-old predicate: never opened (`seen = 0`), older than `months`, not a
 * draft, not flagged (a starred-but-unread message is deliberately kept), not protected.
 * The attention angle — mail never even opened after this long was never needed.
 */
function unreadWhere(months: number): SQL {
  const cutoff = Date.now() - months * MS_PER_MONTH;
  return sql`${ELIGIBLE}
    AND m.seen = 0 AND m.draft = 0 AND m.flagged = 0
    AND m.received_at IS NOT NULL AND m.received_at < ${cutoff}
    AND ${notProtected('m')}`;
}

/**
 * The newsletters predicate: the body carries an unsubscribe / newsletter marker (EN+NO)
 * — the deterministic bulk-mail heuristic, riding the FTS index. The bulk-mail angle.
 */
function newslettersWhere(): SQL {
  const match = ftsOrMatch(effectiveKeywords('cleanupNewsletterKeywords', NEWSLETTER_KEYWORDS));
  return sql`${ELIGIBLE} AND ${notProtected('m')}
    AND m.id IN (SELECT message_id FROM messages_fts WHERE messages_fts MATCH ${match})`;
}

/** Large messages — estimated size ≥ `minMb` (default {@link LARGE_MIN_MB} MB). */
export function largeMessages(minMb = LARGE_MIN_MB, opts: GroupPageOpts = {}): CleanupSliceDto {
  return paginateSlice('large', computeSliceData('large', { minMb }), opts);
}

/** Unread-and-old — never opened and older than `months` (default {@link UNREAD_MONTHS}). */
export function unreadOldMessages(
  months = UNREAD_MONTHS,
  opts: GroupPageOpts = {},
): CleanupSliceDto {
  return paginateSlice('unread', computeSliceData('unread', { months }), opts);
}

/** Newsletters / bulk mail — messages carrying an unsubscribe marker (FTS heuristic). */
export function newsletterMessages(opts: GroupPageOpts = {}): CleanupSliceDto {
  return paginateSlice('newsletters', computeSliceData('newsletters'), opts);
}

/** The delete-eligible slice ids — every angle except the informational storage audit. */
export type DeleteSlice = 'never-replied' | 'cold-storage' | 'large' | 'unread' | 'newsletters';

/** Runtime guard for {@link DeleteSlice} — shared by the routes' input validation. */
export const DELETE_SLICES: ReadonlySet<string> = new Set<DeleteSlice>([
  'never-replied',
  'cold-storage',
  'large',
  'unread',
  'newsletters',
]);

/** Narrow an untrusted slice id to a {@link DeleteSlice}. */
export function isDeleteSlice(slice: string): slice is DeleteSlice {
  return DELETE_SLICES.has(slice);
}

/** Per-slice tunable thresholds (each ignored by the slices it doesn't apply to). */
export interface SliceThresholds {
  /** Cold-storage age threshold (years). */
  years?: number;
  /** Large-message size threshold (MB). */
  minMb?: number;
  /** Unread-and-old age threshold (months). */
  months?: number;
}

/**
 * The never-replied predicate, fully in SQL: an actionable sender key (not '(unknown)')
 * the user has never written to. The reply set is computed in JS from Sent recipients
 * (JSON address blobs) and handed to SQLite as ONE bound JSON array via `json_each` —
 * keeping the predicate composable with COUNT/LIMIT pagination without a bound-variable
 * per key.
 */
function neverRepliedWhere(): SQL {
  const replied = JSON.stringify([...repliedSenderKeys()]);
  return sql`${ELIGIBLE} AND ${notProtected('m')}
    AND ${SENDER_KEY} <> '(unknown)'
    AND ${SENDER_KEY} NOT IN (SELECT value FROM json_each(${replied}))`;
}

/**
 * The shared SQL predicate of a delete-eligible slice — the single source of truth used
 * by the preview, drill-down, and execute paths, so the three can never drift apart.
 */
function sliceWhere(slice: DeleteSlice, t: SliceThresholds): SQL {
  switch (slice) {
    case 'never-replied':
      return neverRepliedWhere();
    case 'cold-storage':
      return coldStorageWhere(t.years ?? COLD_YEARS);
    case 'large':
      return largeWhere((t.minMb ?? LARGE_MIN_MB) * MB);
    case 'unread':
      return unreadWhere(t.months ?? UNREAD_MONTHS);
    case 'newsletters':
      return newslettersWhere();
  }
}

/** Every slice id the dashboard previews — the destructive ones plus the storage audit. */
export type PreviewSlice = 'storage' | DeleteSlice;

/**
 * The single heavy compute behind every slice preview: the full sender group list plus
 * totals for one slice at the given thresholds (defaults applied here). This is what
 * the cleanup cache memoises; the public per-slice functions and the routes paginate it.
 */
export function computeSliceData(slice: PreviewSlice, t: SliceThresholds = {}): SliceData {
  if (slice === 'storage') return dataFromGroups(allGroupsByDomain(LIVE));
  return dataFromGroups(allGroupsByDomain(sliceWhere(slice, t)));
}

/** A single message earmarked for cleanup execution (the trash queue's unit of work). */
export interface CleanupMessageRef {
  id: string;
  accountId: string;
}

/**
 * Resolve a delete-eligible slice to the concrete messages it would trash — the execution
 * counterpart of the preview slices. **Re-runs the exact same predicates server-side** so
 * the HARD safety gate (financial/legal/account/medical) and the slice's own filters are
 * enforced at execution time; the client's previewed list is never trusted.
 *
 * The optional scope narrows the eligible set without ever widening it — this is what makes
 * client-driven selection safe:
 *  - `domain` (a lowercased sender key — domain, or full address for freemail senders):
 *    restrict to one sender — "trash all from this sender".
 *  - `messageIds`: an explicit selection; the result is the **intersection** with the eligible
 *    set, so a stale/forged/now-protected id simply isn't in the set and is silently dropped.
 *  - `excludeDomains` (lowercased sender keys): spare senders from the whole-slice
 *    "Clean all" path.
 *  - `excludeMessageIds`: spare individual messages — the drill-down's "select all,
 *    uncheck a few" path (subtracted last, after every narrowing scope).
 *
 * Only the destructive slices resolve — 'storage' is informational and throws.
 */
export function sliceMessageIds(
  slice: DeleteSlice,
  opts: SliceThresholds & {
    domain?: string;
    messageIds?: string[];
    excludeDomains?: string[];
    excludeMessageIds?: string[];
  } = {},
): CleanupMessageRef[] {
  if (!DELETE_SLICES.has(slice)) {
    throw new Error(`slice '${slice as string}' is not delete-eligible`);
  }
  const exclude = new Set((opts.excludeDomains ?? []).map((d) => d.toLowerCase()));
  const only = opts.domain?.toLowerCase();
  const ids = opts.messageIds ? new Set(opts.messageIds) : null;
  const spared = new Set(opts.excludeMessageIds ?? []);

  const rows = db.all(
    sql`SELECT m.id AS id, m.account_id AS accountId, ${SENDER_KEY} AS domain
        FROM messages m WHERE ${sliceWhere(slice, opts)}`,
  ) as { id: string; accountId: string; domain: string }[];

  return rows
    .filter((r) => !exclude.has(r.domain))
    .filter((r) => !only || r.domain === only)
    .filter((r) => !ids || ids.has(r.id))
    .filter((r) => !spared.has(r.id))
    .map((r) => ({ id: r.id, accountId: r.accountId }));
}

/** Default cap on returned drill-down messages (the review surface, not a bulk export). */
const MESSAGE_LIMIT = 200;

interface RawMessage {
  id: string;
  subject: string | null;
  fromName: string | null;
  fromAddress: string | null;
  receivedAt: number | null;
  bytes: number | null;
  domain: string;
}

const toMessage = (r: RawMessage): CleanupMessageDto => ({
  id: r.id,
  subject: r.subject,
  fromName: r.fromName,
  fromAddress: r.fromAddress,
  receivedAt: iso(r.receivedAt),
  bytes: r.bytes ?? 0,
});

/**
 * Drill a delete-eligible slice down to its individual messages (ROADMAP Phase 6b review
 * surface), optionally scoped to one sender `domain` (a sender key). Reuses the EXACT
 * slice + safety predicates of the preview/execute paths, so the listed messages are
 * precisely what an execute would trash. Newest-first; returns the `[offset, offset+limit)`
 * page with `total`/`totalBytes` over the whole match and a `truncated` flag (more rows
 * exist past this page). `q` narrows to messages whose subject or sender contains the term
 * (an `instr` over the small header columns, not an FTS bypass).
 *
 * Pagination is pushed into SQL: one aggregate (COUNT + byte SUM) plus one page query whose
 * inner subquery selects just the page's ids — so the per-row {@link BYTES} estimate (a
 * correlated attachments sub-select) is only evaluated for the rows actually returned,
 * instead of materialising the entire slice on every page/filter request (the old path,
 * which made the drill-down feel slow on big slices). Only the destructive slices drill —
 * 'storage' is informational and throws.
 */
export function sliceMessages(
  slice: DeleteSlice,
  opts: SliceThresholds & { domain?: string; q?: string; limit?: number; offset?: number } = {},
): { messages: CleanupMessageDto[]; total: number; totalBytes: number; truncated: boolean } {
  const limit = opts.limit ?? MESSAGE_LIMIT;
  const offset = opts.offset && opts.offset > 0 ? opts.offset : 0;
  const domain = opts.domain?.toLowerCase();

  let where = sliceWhere(slice, opts);
  if (domain) where = sql`${where} AND ${SENDER_KEY} = ${domain}`;
  const q = opts.q?.trim();
  if (q) {
    // Case-insensitive contains over the header columns. SQLite's lower() folds ASCII
    // only, so also try the raw term — exact-case matches for non-ASCII still hit.
    const lowered = q.toLowerCase();
    where = sql`${where} AND (
      instr(lower(coalesce(m.subject, '')), ${lowered}) > 0
      OR instr(coalesce(m.subject, ''), ${q}) > 0
      OR instr(lower(coalesce(m.from_name, '')), ${lowered}) > 0
      OR instr(coalesce(m.from_name, ''), ${q}) > 0
      OR instr(lower(coalesce(m.from_address, '')), ${lowered}) > 0
    )`;
  }

  const agg = db.get(
    sql`SELECT COUNT(*) AS total, COALESCE(SUM(${BYTES}), 0) AS totalBytes
        FROM messages m WHERE ${where}`,
  ) as { total: number; totalBytes: number };

  const rows = db.all(
    sql`SELECT m.id AS id, m.subject AS subject, m.from_name AS fromName,
               m.from_address AS fromAddress, m.received_at AS receivedAt,
               ${BYTES} AS bytes, ${SENDER_KEY} AS domain
        FROM messages m
        WHERE m.id IN (
          SELECT m.id FROM messages m WHERE ${where}
          ORDER BY m.received_at DESC
          LIMIT ${limit} OFFSET ${offset}
        )
        ORDER BY m.received_at DESC`,
  ) as RawMessage[];

  return {
    messages: rows.map(toMessage),
    total: agg.total,
    totalBytes: agg.totalBytes,
    truncated: offset + limit < agg.total,
  };
}

/** Top-line dashboard figures: total live mail, estimated bytes, and protected count. */
export function cleanupSummary(): CleanupSummaryDto {
  const { totalMessages, totalBytes } = totalsFor(LIVE);
  const prot = db.get(
    sql`SELECT COUNT(*) AS n FROM messages m
        WHERE ${LIVE}
        AND m.id IN (SELECT message_id FROM messages_fts WHERE messages_fts MATCH ${protectedMatch()})`,
  ) as { n: number };
  // "Freed so far" — messages the cleanup queue has finished moving to Trash. The local
  // tombstones persist, so this is a durable running tally of what cleanup achieved.
  const trashed = db.get(
    sql`SELECT COUNT(*) AS n, COALESCE(SUM(${BYTES}), 0) AS b FROM messages m
        WHERE m.id IN (SELECT message_id FROM cleanup_queue WHERE status = 'done')`,
  ) as { n: number; b: number };
  // Manually guarded (cleanup_keep) live mail — the "Guarded mail" section's badge count.
  const kept = db.get(
    sql`SELECT COUNT(*) AS n FROM messages m WHERE ${LIVE} AND m.cleanup_keep = 1`,
  ) as { n: number };
  return {
    totalMessages,
    totalBytes,
    protectedMessages: prot.n,
    trashedMessages: trashed.n,
    trashedBytes: trashed.b,
    keptMessages: kept.n,
  };
}

/**
 * The manually-guarded messages (cleanup_keep set), newest first — the list behind the
 * Cleanup screen's "Guarded mail" section. Paged like {@link sliceMessages}; lets the user
 * see (and release) anything they shielded by mistake. Not a delete-eligible slice, so it
 * carries no safety predicate — guarded mail is, by definition, the user's keep set.
 */
export function keptMessages(opts: { limit?: number; offset?: number } = {}): {
  messages: CleanupMessageDto[];
  total: number;
  truncated: boolean;
} {
  const limit = opts.limit ?? MESSAGE_LIMIT;
  const offset = opts.offset && opts.offset > 0 ? opts.offset : 0;
  const where = sql`${LIVE} AND m.cleanup_keep = 1`;

  const agg = db.get(sql`SELECT COUNT(*) AS total FROM messages m WHERE ${where}`) as {
    total: number;
  };

  const rows = db.all(
    sql`SELECT m.id AS id, m.subject AS subject, m.from_name AS fromName,
               m.from_address AS fromAddress, m.received_at AS receivedAt, ${BYTES} AS bytes
        FROM messages m
        WHERE ${where}
        ORDER BY m.received_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
  ) as RawMessage[];

  return { messages: rows.map(toMessage), total: agg.total, truncated: offset + limit < agg.total };
}
