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
import { getPrefs } from '../db/settings.js';
import { PROTECTED_KEYWORDS } from './keywords.js';

/** Build an FTS5 MATCH expression: prefix-match each term, OR-joined. */
export function ftsOrMatch(terms: string[]): string {
  return terms.map((t) => `"${t}"*`).join(' OR ');
}

/** The cleanup keyword lists the user can extend from the Cleanup screen (synced prefs blob). */
export type CustomKeywordKey =
  | 'cleanupColdKeepKeywords'
  | 'cleanupNewsletterKeywords'
  | 'cleanupProtectedKeywords';

/**
 * User-added keyword markers for `key`, read from the synced prefs blob and merged on top of
 * the built-in sets (the Cleanup screen lets the user tune the cold-storage "keep", newsletter,
 * and protected lists). Each term is lowercased, stripped of double quotes (they'd break the FTS
 * phrase wrapper in {@link ftsOrMatch}) and de-duped; an absent/garbled pref yields no extras.
 */
export function customKeywords(key: CustomKeywordKey): string[] {
  const raw = (getPrefs() as Record<string, unknown>)[key];
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const x of raw) {
    if (typeof x !== 'string') continue;
    const term = x.trim().toLowerCase().replace(/"/g, '');
    if (term) out.add(term);
  }
  return [...out];
}

/**
 * FTS5 MATCH expression selecting protected mail — the built-in safety categories PLUS the
 * user's custom additions. Computed per call (not a module constant) so a freshly-edited
 * protected list takes effect on the next slice query without a process restart.
 */
export function protectedMatch(): string {
  return ftsOrMatch([...PROTECTED_KEYWORDS, ...customKeywords('cleanupProtectedKeywords')]);
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
  const folded = [...PROTECTED_KEYWORDS, ...customKeywords('cleanupProtectedKeywords')].map(fold);
  const text = [parts.subject, parts.body, parts.from].filter(Boolean).join(' ');
  const tokens = fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.some((tok) => folded.some((kw) => tok.startsWith(kw)));
}
