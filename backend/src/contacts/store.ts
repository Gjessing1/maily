/**
 * Contacts cache persistence + lookup (ROADMAP §3.7.D). The `contacts` table is a
 * rebuildable mirror of the Radicale addressbook; this module owns writing it and
 * the two read paths over it:
 *   - compose autocomplete (`searchContacts`),
 *   - sender-name enrichment (`contactNameFor`) — an in-memory email→name map so
 *     mapping a list of messages to DTOs costs no per-message query.
 */
import { sql } from 'drizzle-orm';
import type { ContactDto } from '@maily/shared';
import { db, sqlite } from '../db/client.js';
import { contacts } from '../db/schema.js';

/** A parsed contact ready to persist (one row per email). */
export interface ParsedContact {
  email: string;
  name: string | null;
  vcardUid: string | null;
}

/** In-memory email→display-name map, rebuilt from the DB after every sync. */
let nameByEmail = new Map<string, string>();

/** Resolve a display name for an address from the contacts cache, or null. */
export function contactNameFor(email: string | null): string | null {
  if (!email) return null;
  return nameByEmail.get(email.toLowerCase()) ?? null;
}

/** Rebuild the in-memory name map from the contacts table. */
export function reloadContactCache(): void {
  const rows = db.select({ email: contacts.email, name: contacts.name }).from(contacts).all();
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.name) map.set(r.email, r.name);
  }
  nameByEmail = map;
}

/**
 * Replace the entire contacts cache with a freshly-synced set. Deduped by email
 * (the unique key); the last card wins on collision. Runs in one transaction so a
 * reader never sees a half-rebuilt table.
 */
export function replaceContacts(parsed: ParsedContact[]): number {
  const byEmail = new Map<string, ParsedContact>();
  for (const c of parsed) {
    const email = c.email.trim().toLowerCase();
    if (!email) continue;
    byEmail.set(email, { ...c, email });
  }

  const rows = [...byEmail.values()];
  const tx = sqlite.transaction(() => {
    db.delete(contacts).run();
    for (const r of rows) {
      db.insert(contacts).values({ email: r.email, name: r.name, vcardUid: r.vcardUid }).run();
    }
  });
  tx();
  reloadContactCache();
  return rows.length;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Autocomplete: contacts whose name or email contains `q` (small table → LIKE is fine). */
export function searchContacts(q: string, limit: number): ContactDto[] {
  const term = q.trim();
  if (!term) return [];
  const like = `%${escapeLike(term)}%`;
  return db
    .select({ name: contacts.name, email: contacts.email })
    .from(contacts)
    .where(
      sql`(${contacts.email} LIKE ${like} ESCAPE '\\' OR ${contacts.name} LIKE ${like} ESCAPE '\\')`,
    )
    .orderBy(contacts.name)
    .limit(limit)
    .all();
}
