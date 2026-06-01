/**
 * Account row reconciliation. Maps an `AccountConfig` (from env) to its DB row,
 * inserting on first sight and refreshing the non-secret connection metadata.
 * Secrets are never written here — only host/port/email/provider.
 */
import { eq } from 'drizzle-orm';
import { db } from './client.js';
import { accounts } from './schema.js';
import type { AccountConfig } from '../config/accounts.js';

export type AccountRow = typeof accounts.$inferSelect;

/** Insert-or-update the account row for a config; returns the persisted row. */
export function ensureAccount(config: AccountConfig): AccountRow {
  const existing = db.select().from(accounts).where(eq(accounts.email, config.email)).get();

  const fields = {
    email: config.email,
    displayName: config.displayName ?? null,
    provider: config.provider,
    imapHost: config.imap.host,
    imapPort: config.imap.port,
    smtpHost: config.smtp.host,
    smtpPort: config.smtp.port,
  } as const;

  if (existing) {
    db.update(accounts).set(fields).where(eq(accounts.id, existing.id)).run();
    return { ...existing, ...fields };
  }

  return db.insert(accounts).values(fields).returning().get();
}
