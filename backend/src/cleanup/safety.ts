/**
 * Cleanup safety filter (ROADMAP Phase 6 "Risk & safety filters — HARD RULES").
 * Financial / legal / account-security / medical-identity mail is *protected*: it never
 * appears in a delete-eligible slice and never lands in a delete preset. This is the
 * non-negotiable gate every destructive slice AND-s into its query.
 *
 * Matching reuses the FTS5 index (`messages_fts`) — never a LIKE-scan over the body
 * (ARCHITECTURE §12). The index tokenizes with `remove_diacritics 2`, so the Norwegian
 * terms match with or without diacritics. We prefix-match (`"term"*`) so plurals /
 * inflections (invoice→invoices, faktura→fakturaer) are caught too — over-protecting is
 * the safe direction for a delete filter.
 */
import { sql, type SQL } from 'drizzle-orm';
import { PROTECTED_KEYWORDS } from './keywords.js';

/** Build an FTS5 MATCH expression: prefix-match each term, OR-joined. */
export function ftsOrMatch(terms: string[]): string {
  return terms.map((t) => `"${t}"*`).join(' OR ');
}

/** FTS5 MATCH expression selecting messages in any protected category. */
export const PROTECTED_MATCH = ftsOrMatch(PROTECTED_KEYWORDS);

/**
 * SQL predicate excluding protected mail, for AND-ing into a slice query. `alias` is the
 * messages-table alias the slice uses (e.g. `m`). Implemented as a NOT IN against an FTS5
 * MATCH subquery so the keyword scan stays on the index.
 */
export function notProtected(alias = 'm'): SQL {
  return sql`${sql.raw(alias)}.id NOT IN (SELECT message_id FROM messages_fts WHERE messages_fts MATCH ${PROTECTED_MATCH})`;
}

/** Normalize for diacritic-insensitive comparison (mirrors the FTS tokenizer). */
function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

const FOLDED_PROTECTED = PROTECTED_KEYWORDS.map(fold);

/**
 * Pure per-message protected check (the JS counterpart of `notProtected` / `PROTECTED_MATCH`).
 * Tokenizes the message text and treats it as protected if any token *prefix-matches* a
 * protected keyword — the same semantics as the FTS query. Used in tests and available for
 * future per-message decisions.
 */
export function isProtected(parts: {
  subject?: string | null;
  body?: string | null;
  from?: string | null;
}): boolean {
  const text = [parts.subject, parts.body, parts.from].filter(Boolean).join(' ');
  const tokens = fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.some((tok) => FOLDED_PROTECTED.some((kw) => tok.startsWith(kw)));
}
