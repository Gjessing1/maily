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
import { getServerSettings, type KeywordListKey } from '../db/settings.js';
import { PROTECTED_KEYWORDS } from './keywords.js';

/** Build an FTS5 MATCH expression: prefix-match each term, OR-joined. */
export function ftsOrMatch(terms: string[]): string {
  return terms.map((t) => `"${t}"*`).join(' OR ');
}

/**
 * The effective keyword list for `key`: the user's own list from the server settings when they
 * have customised it, else `defaults`. This is a full *replacement* model, not additive — the
 * Cleanup screen seeds the editor from the built-ins, so removing a built-in there persists a
 * shorter list and that built-in stops applying. An empty list falls back to the built-ins (so
 * saving nothing can never silently switch a gate off; reset = revert to defaults). Terms arrive
 * normalised for {@link ftsOrMatch}: lowercased, without double quotes, de-duped.
 */
export function effectiveKeywords(key: KeywordListKey, defaults: string[]): string[] {
  const list = getServerSettings()[key];
  return list.length > 0 ? list : defaults;
}

/** The effective protected-safety keyword list (built-ins, user-extended or user-trimmed). */
export function protectedKeywords(): string[] {
  return effectiveKeywords('cleanupProtectedKeywords', PROTECTED_KEYWORDS);
}

/**
 * FTS5 MATCH expression selecting protected mail, from the effective protected list. Computed
 * per call (not a module constant) so a freshly-edited list takes effect on the next slice query.
 */
export function protectedMatch(): string {
  return ftsOrMatch(protectedKeywords());
}

/**
 * SQL predicate excluding protected mail, for AND-ing into a slice query. `alias` is the
 * messages-table alias the slice uses (e.g. `m`). Implemented as a NOT IN against an FTS5
 * MATCH subquery so the keyword scan stays on the index.
 */
export function notProtected(alias = 'm'): SQL {
  return sql`${sql.raw(alias)}.id NOT IN (SELECT message_id FROM messages_fts WHERE messages_fts MATCH ${protectedMatch()})`;
}

/** Normalize for diacritic-insensitive comparison (mirrors the FTS tokenizer). */
function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

/**
 * Pure per-message protected check (the JS counterpart of `notProtected` / `protectedMatch`).
 * Tokenizes the message text and treats it as protected if any token *prefix-matches* a
 * protected keyword (built-in or user-added) — the same semantics as the FTS query. Used in
 * tests and available for future per-message decisions.
 */
export function isProtected(parts: {
  subject?: string | null;
  body?: string | null;
  from?: string | null;
}): boolean {
  const folded = protectedKeywords().map(fold);
  const text = [parts.subject, parts.body, parts.from].filter(Boolean).join(' ');
  const tokens = fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.some((tok) => folded.some((kw) => tok.startsWith(kw)));
}
