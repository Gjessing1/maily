/**
 * App-settings store (ROADMAP §B). Single-user UI preferences persisted server-side
 * so they sync across every device instead of living only in each browser's
 * localStorage. Stored as a JSON blob under one key; never holds secrets (§5).
 */
import { eq, sql } from 'drizzle-orm';
import { db } from './client.js';
import { appSettings } from './schema.js';

/** Well-known key under which the whole prefs object lives. */
const PREFS_KEY = 'prefs';

/** The stored prefs object, or `{}` when nothing has been saved yet. */
export function getPrefs(): Record<string, unknown> {
  const row = db.select().from(appSettings).where(eq(appSettings.key, PREFS_KEY)).get();
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Replace the stored prefs object wholesale (the client owns the schema). */
export function putPrefs(value: Record<string, unknown>): void {
  const json = JSON.stringify(value);
  db.insert(appSettings)
    .values({ key: PREFS_KEY, value: json, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: json, updatedAt: sql`(unixepoch() * 1000)` },
    })
    .run();
}
