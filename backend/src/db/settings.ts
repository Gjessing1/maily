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
  putSetting(PREFS_KEY, value);
}

/** Read a JSON-encoded setting by key, or `fallback` when absent/unparseable. */
export function getSetting<T>(key: string, fallback: T): T {
  const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get();
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

/** Upsert a JSON-encoded setting under `key`. Never holds secrets (§5). */
export function putSetting(key: string, value: unknown): void {
  const json = JSON.stringify(value);
  db.insert(appSettings)
    .values({ key, value: json, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: json, updatedAt: sql`(unixepoch() * 1000)` },
    })
    .run();
}
