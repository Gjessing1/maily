/**
 * Deterministic cleanup slices (ROADMAP Phase 6 "Master archive & Cleanup Dashboard").
 * Read-only power-user analytics over the local SQLite archive — the slices that ship
 * *first* because they need no enrichment: a storage audit, senders never replied to,
 * and cold-storage candidates. Each returns a **preview impact** (message count + an
 * estimated byte total, grouped by sender domain) so the eventual 1-click presets can
 * always show "delete N, free X" before any execution.
 *
 * Two invariants:
 *  - **Never delete-eligible without the safety gate.** The destructive slices
 *    (never-replied, cold-storage) AND-in `notProtected` so financial / legal /
 *    account-security / medical mail (EN+NO) can never surface (ROADMAP HARD RULES).
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
import { COLD_KEEP_KEYWORDS } from './keywords.js';
import { ftsOrMatch, notProtected, PROTECTED_MATCH } from './safety.js';

/** Default cap on returned groups per slice — the dashboard shows the worst offenders. */
const GROUP_LIMIT = 50;
/** Default cold-storage age threshold (years). */
const COLD_YEARS = 2;
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

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
 * Run the grouped storage query for a `WHERE` predicate. Returns rows newest-bytes-first;
 * fetches one past the limit so the caller can flag truncation without a second COUNT.
 */
function groupedByDomain(
  where: SQL,
  limit: number,
): { groups: CleanupGroupDto[]; truncated: boolean } {
  const rows = db.all(
    sql`SELECT ${DOMAIN} AS domain,
               COUNT(*) AS messageCount,
               SUM(${BYTES}) AS bytes,
               MIN(m.received_at) AS oldestAt,
               MAX(m.received_at) AS newestAt
        FROM messages m
        WHERE ${where}
        GROUP BY domain
        ORDER BY bytes DESC
        LIMIT ${limit + 1}`,
  ) as RawGroup[];
  const truncated = rows.length > limit;
  return { groups: rows.slice(0, limit).map(toGroup), truncated };
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
export function storageByDomain(limit = GROUP_LIMIT): CleanupSliceDto {
  const { groups, truncated } = groupedByDomain(LIVE, limit);
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
export function neverRepliedSenders(limit = GROUP_LIMIT): CleanupSliceDto {
  const replied = repliedDomains();
  const where = sql`${LIVE} AND ${notProtected('m')}`;

  // Pull all candidate domain groups, then drop those we've replied to / can't act on.
  const all = (
    db.all(
      sql`SELECT ${DOMAIN} AS domain,
                 COUNT(*) AS messageCount,
                 SUM(${BYTES}) AS bytes,
                 MIN(m.received_at) AS oldestAt,
                 MAX(m.received_at) AS newestAt
          FROM messages m
          WHERE ${where}
          GROUP BY domain
          ORDER BY bytes DESC`,
    ) as RawGroup[]
  ).filter((r) => r.domain !== '(unknown)' && !replied.has(r.domain));

  const totalMessages = all.reduce((n, r) => n + r.messageCount, 0);
  const totalBytes = all.reduce((n, r) => n + (r.bytes ?? 0), 0);
  return {
    slice: 'never-replied',
    groups: all.slice(0, limit).map(toGroup),
    truncated: all.length > limit,
    totalMessages,
    totalBytes,
  };
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
export function coldStorageCandidates(years = COLD_YEARS, limit = GROUP_LIMIT): CleanupSliceDto {
  const where = coldStorageWhere(years);
  const { groups, truncated } = groupedByDomain(where, limit);
  return { slice: 'cold-storage', groups, truncated, ...totalsFor(where) };
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
 * enforced at execution time; the client's previewed list is never trusted. `excludeDomains`
 * (lowercased) implements the dashboard's "uncheck by domain" affordance.
 *
 * Only the destructive slices resolve — 'storage' is informational and throws.
 */
export function sliceMessageIds(
  slice: 'never-replied' | 'cold-storage',
  opts: { years?: number; excludeDomains?: string[] } = {},
): CleanupMessageRef[] {
  const exclude = new Set((opts.excludeDomains ?? []).map((d) => d.toLowerCase()));

  if (slice === 'cold-storage') {
    const rows = db.all(
      sql`SELECT m.id AS id, m.account_id AS accountId, ${DOMAIN} AS domain
          FROM messages m WHERE ${coldStorageWhere(opts.years ?? COLD_YEARS)}`,
    ) as { id: string; accountId: string; domain: string }[];
    return rows
      .filter((r) => !exclude.has(r.domain))
      .map((r) => ({ id: r.id, accountId: r.accountId }));
  }

  if (slice === 'never-replied') {
    const replied = repliedDomains();
    const rows = db.all(
      sql`SELECT m.id AS id, m.account_id AS accountId, ${DOMAIN} AS domain
          FROM messages m WHERE ${LIVE} AND ${notProtected('m')}`,
    ) as { id: string; accountId: string; domain: string }[];
    return rows
      .filter((r) => r.domain !== '(unknown)' && !replied.has(r.domain) && !exclude.has(r.domain))
      .map((r) => ({ id: r.id, accountId: r.accountId }));
  }

  throw new Error(`slice '${slice as string}' is not delete-eligible`);
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
  slice: 'never-replied' | 'cold-storage',
  opts: { years?: number; domain?: string; limit?: number; offset?: number } = {},
): { messages: CleanupMessageDto[]; total: number; truncated: boolean } {
  const limit = opts.limit ?? MESSAGE_LIMIT;
  const offset = opts.offset && opts.offset > 0 ? opts.offset : 0;
  const domain = opts.domain?.toLowerCase();

  const base =
    slice === 'cold-storage'
      ? coldStorageWhere(opts.years ?? COLD_YEARS)
      : sql`${LIVE} AND ${notProtected('m')}`;
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
