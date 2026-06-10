/**
 * Deterministic cleanup slices (ROADMAP Phase 6 "Master archive & Cleanup Dashboard").
 * Read-only power-user analytics over the local SQLite archive — slices that need no
 * enrichment, each a different *angle* on "what could I be tempted to delete":
 *  - storage audit (informational), senders never replied to, cold-storage candidates,
 *  - large messages (size angle), unread-and-old (attention angle),
 *  - newsletters (bulk-mail angle via the FTS unsubscribe heuristic).
 * Each returns a **preview impact** (message count + an estimated byte total, grouped by
 * sender domain) so the dashboard can always show "delete N, free X" before any execution.
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
import { ftsOrMatch, notProtected, PROTECTED_MATCH } from './safety.js';

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
 * Per-message byte estimate: the archived raw `.eml` size (`source_bytes`, the dominant
 * true cost — captured at archive time, ROADMAP §3.7.E) plus the parsed body (text + html)
 * and attachment sizes for any message not yet archived (null `source_bytes`). Computed
 * live from existing columns; the `.eml` size is read from a column because a SQL aggregate
 * can't stat a file. For an archived message the body+attachment terms double-count a small
 * slice already inside the `.eml`, but the `.eml` figure dominates and this stays a fast,
 * file-stat-free estimate.
 */
const BYTES = sql`(
  coalesce(m.source_bytes, 0)
  + length(coalesce(m.body_text, '')) + length(coalesce(m.body_html, ''))
  + coalesce((SELECT SUM(a.size_bytes) FROM attachments a WHERE a.message_id = m.id), 0)
)`;

/** Sender domain (lowercased); '(unknown)' when the address is missing or domain-less. */
const DOMAIN = sql`CASE
  WHEN m.from_address IS NULL OR instr(m.from_address, '@') = 0 THEN '(unknown)'
  ELSE lower(substr(m.from_address, instr(m.from_address, '@') + 1))
END`;

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
 * Run the grouped storage query for a `WHERE` predicate, returning EVERY sender-domain group
 * (bytes-descending). The distinct-domain count is small (hundreds–low thousands), so paging
 * and substring search happen in JS via {@link paginateGroups} — that keeps a sender search
 * able to reach the long tail without a body-scanning `LIKE` (ARCHITECTURE §12 forbids those
 * for message search; this is a tiny domain-label filter, not an FTS bypass).
 */
function allGroupsByDomain(where: SQL): CleanupGroupDto[] {
  const rows = db.all(
    sql`SELECT ${DOMAIN} AS domain,
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
  /** Case-insensitive sender-domain substring filter (the "Browse by sender" search box). */
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
 * Storage audit — every sender domain by estimated bytes. Informational, so NOT
 * safety-filtered (a storage audit shows all mail; it never proposes deletion).
 */
export function storageByDomain(opts: GroupPageOpts = {}): CleanupSliceDto {
  const { groups, truncated } = paginateGroups(allGroupsByDomain(LIVE), opts);
  return { slice: 'storage', groups, truncated, ...totalsFor(LIVE) };
}

/** Lowercased domain of an email address, or null if it has none. */
function domainOf(address: string | null | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1).toLowerCase() : null;
}

/** Collect the set of domains the user has ever sent mail to (To + Cc of Sent mail). */
function repliedDomains(): Set<string> {
  const rows = db.all(
    sql`SELECT m.to_addresses AS toA, m.cc_addresses AS ccA
        FROM messages m
        JOIN message_folders mf ON mf.message_id = m.id
        JOIN folders f ON f.id = mf.folder_id
        WHERE f.role = 'sent'`,
  ) as { toA: string | null; ccA: string | null }[];

  const domains = new Set<string>();
  for (const row of rows) {
    for (const json of [row.toA, row.ccA]) {
      if (!json) continue;
      try {
        const list = JSON.parse(json) as { address?: string }[];
        for (const a of list) {
          const d = domainOf(a.address);
          if (d) domains.add(d);
        }
      } catch {
        // Tolerate a malformed recipients blob — just skip it.
      }
    }
  }
  return domains;
}

/**
 * Senders never replied to — inbound domains the user has never written back to. A
 * passive bulk-unsubscribe / clutter candidate. Safety-filtered (protected mail excluded)
 * and the '(unknown)' bucket dropped (not actionable). Reply set is computed from Sent.
 */
export function neverRepliedSenders(opts: GroupPageOpts = {}): CleanupSliceDto {
  const replied = repliedDomains();
  const where = sql`${LIVE} AND ${notProtected('m')}`;

  // All candidate groups minus those we've replied to / can't act on; total over the full set.
  const all = allGroupsByDomain(where).filter(
    (g) => g.domain !== '(unknown)' && !replied.has(g.domain),
  );
  const totalMessages = all.reduce((n, g) => n + g.messageCount, 0);
  const totalBytes = all.reduce((n, g) => n + g.bytes, 0);
  const { groups, truncated } = paginateGroups(all, opts);
  return { slice: 'never-replied', groups, truncated, totalMessages, totalBytes };
}

/**
 * The cold-storage predicate: mail older than `years` whose body lacks the value markers
 * (invoice/tax/contract, EN+NO) and which isn't protected. Shared by the preview slice and
 * the execution resolver so both apply the identical safety + keyword + age filter.
 */
function coldStorageWhere(years: number): SQL {
  const cutoff = Date.now() - years * MS_PER_YEAR;
  const coldMatch = ftsOrMatch(COLD_KEEP_KEYWORDS);
  return sql`${LIVE}
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
  const where = coldStorageWhere(years);
  const { groups, truncated } = paginateGroups(allGroupsByDomain(where), opts);
  return { slice: 'cold-storage', groups, truncated, ...totalsFor(where) };
}

/**
 * The large-message predicate: estimated size ≥ `minBytes`, not protected. The size
 * angle — a single fat message (usually attachments) is the quickest storage win.
 */
function largeWhere(minBytes: number): SQL {
  return sql`${LIVE} AND ${notProtected('m')} AND ${BYTES} >= ${minBytes}`;
}

/**
 * The unread-and-old predicate: never opened (`seen = 0`), older than `months`, not a
 * draft, not flagged (a starred-but-unread message is deliberately kept), not protected.
 * The attention angle — mail never even opened after this long was never needed.
 */
function unreadWhere(months: number): SQL {
  const cutoff = Date.now() - months * MS_PER_MONTH;
  return sql`${LIVE}
    AND m.seen = 0 AND m.draft = 0 AND m.flagged = 0
    AND m.received_at IS NOT NULL AND m.received_at < ${cutoff}
    AND ${notProtected('m')}`;
}

/**
 * The newsletters predicate: the body carries an unsubscribe / newsletter marker (EN+NO)
 * — the deterministic bulk-mail heuristic, riding the FTS index. The bulk-mail angle.
 */
function newslettersWhere(): SQL {
  const match = ftsOrMatch(NEWSLETTER_KEYWORDS);
  return sql`${LIVE} AND ${notProtected('m')}
    AND m.id IN (SELECT message_id FROM messages_fts WHERE messages_fts MATCH ${match})`;
}

/** Large messages — estimated size ≥ `minMb` (default {@link LARGE_MIN_MB} MB). */
export function largeMessages(minMb = LARGE_MIN_MB, opts: GroupPageOpts = {}): CleanupSliceDto {
  const where = largeWhere(minMb * MB);
  const { groups, truncated } = paginateGroups(allGroupsByDomain(where), opts);
  return { slice: 'large', groups, truncated, ...totalsFor(where) };
}

/** Unread-and-old — never opened and older than `months` (default {@link UNREAD_MONTHS}). */
export function unreadOldMessages(
  months = UNREAD_MONTHS,
  opts: GroupPageOpts = {},
): CleanupSliceDto {
  const where = unreadWhere(months);
  const { groups, truncated } = paginateGroups(allGroupsByDomain(where), opts);
  return { slice: 'unread', groups, truncated, ...totalsFor(where) };
}

/** Newsletters / bulk mail — messages carrying an unsubscribe marker (FTS heuristic). */
export function newsletterMessages(opts: GroupPageOpts = {}): CleanupSliceDto {
  const where = newslettersWhere();
  const { groups, truncated } = paginateGroups(allGroupsByDomain(where), opts);
  return { slice: 'newsletters', groups, truncated, ...totalsFor(where) };
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
 * The shared SQL predicate of a pure-SQL delete-eligible slice (everything except
 * never-replied, whose reply-set filter runs in JS). Single source of truth so the
 * preview, drill-down, and execute paths can never drift apart.
 */
function sqlSliceWhere(slice: Exclude<DeleteSlice, 'never-replied'>, t: SliceThresholds): SQL {
  switch (slice) {
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
 *  - `domain` (lowercased): restrict to one sender — "trash all from this sender".
 *  - `messageIds`: an explicit selection; the result is the **intersection** with the eligible
 *    set, so a stale/forged/now-protected id simply isn't in the set and is silently dropped.
 *  - `excludeDomains` (lowercased): spare senders from the whole-slice "Clean all" path.
 *
 * Only the destructive slices resolve — 'storage' is informational and throws.
 */
export function sliceMessageIds(
  slice: DeleteSlice,
  opts: SliceThresholds & {
    domain?: string;
    messageIds?: string[];
    excludeDomains?: string[];
  } = {},
): CleanupMessageRef[] {
  const exclude = new Set((opts.excludeDomains ?? []).map((d) => d.toLowerCase()));
  const only = opts.domain?.toLowerCase();
  const ids = opts.messageIds ? new Set(opts.messageIds) : null;

  let rows: { id: string; accountId: string; domain: string }[];
  if (slice === 'never-replied') {
    const replied = repliedDomains();
    rows = (
      db.all(
        sql`SELECT m.id AS id, m.account_id AS accountId, ${DOMAIN} AS domain
            FROM messages m WHERE ${LIVE} AND ${notProtected('m')}`,
      ) as typeof rows
    ).filter((r) => r.domain !== '(unknown)' && !replied.has(r.domain));
  } else if (DELETE_SLICES.has(slice)) {
    rows = db.all(
      sql`SELECT m.id AS id, m.account_id AS accountId, ${DOMAIN} AS domain
          FROM messages m WHERE ${sqlSliceWhere(slice, opts)}`,
    ) as typeof rows;
  } else {
    throw new Error(`slice '${slice as string}' is not delete-eligible`);
  }

  return rows
    .filter((r) => !exclude.has(r.domain))
    .filter((r) => !only || r.domain === only)
    .filter((r) => !ids || ids.has(r.id))
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
 * surface), optionally scoped to one sender `domain`. Reuses the EXACT slice + safety
 * predicates of the preview/execute paths, so the listed messages are precisely what an
 * execute would trash. Newest-first; returns the `[offset, offset+limit)` page with a
 * `total` count and a `truncated` flag (more rows exist past this page) so the drill-down
 * can paginate. Only the destructive slices drill — 'storage' is informational and throws.
 */
export function sliceMessages(
  slice: DeleteSlice,
  opts: SliceThresholds & { domain?: string; limit?: number; offset?: number } = {},
): { messages: CleanupMessageDto[]; total: number; truncated: boolean } {
  const limit = opts.limit ?? MESSAGE_LIMIT;
  const offset = opts.offset && opts.offset > 0 ? opts.offset : 0;
  const domain = opts.domain?.toLowerCase();

  const base =
    slice === 'never-replied' ? sql`${LIVE} AND ${notProtected('m')}` : sqlSliceWhere(slice, opts);
  const where = domain ? sql`${base} AND ${DOMAIN} = ${domain}` : base;

  const rows = db.all(
    sql`SELECT m.id AS id, m.subject AS subject, m.from_name AS fromName,
               m.from_address AS fromAddress, m.received_at AS receivedAt,
               ${BYTES} AS bytes, ${DOMAIN} AS domain
        FROM messages m
        WHERE ${where}
        ORDER BY m.received_at DESC`,
  ) as RawMessage[];

  // never-replied filters the reply set + '(unknown)' bucket in JS (same as the slice/exec).
  let matched = rows;
  if (slice === 'never-replied') {
    const replied = repliedDomains();
    matched = rows.filter((r) => r.domain !== '(unknown)' && !replied.has(r.domain));
  }

  return {
    messages: matched.slice(offset, offset + limit).map(toMessage),
    total: matched.length,
    truncated: offset + limit < matched.length,
  };
}

/** Top-line dashboard figures: total live mail, estimated bytes, and protected count. */
export function cleanupSummary(): CleanupSummaryDto {
  const { totalMessages, totalBytes } = totalsFor(LIVE);
  const prot = db.get(
    sql`SELECT COUNT(*) AS n FROM messages m
        WHERE ${LIVE}
        AND m.id IN (SELECT message_id FROM messages_fts WHERE messages_fts MATCH ${PROTECTED_MATCH})`,
  ) as { n: number };
  return { totalMessages, totalBytes, protectedMessages: prot.n };
}
