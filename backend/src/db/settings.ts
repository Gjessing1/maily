/**
 * `app_settings` key-value store. Besides the per-feature keys (address books, calendars, the
 * download budget) it holds two single-user settings documents with different owners:
 *
 * - `prefs` — UI preferences. The client owns their schema and the server never reads them.
 *   Writes are top-level merge patches, so two devices changing different prefs can't overwrite
 *   each other.
 * - `server.settings` — {@link ServerSettings}, which the server acts on (the cleanup safety
 *   gate, the undo-send hold). Validated on write and normalised on read here.
 *
 * Never holds secrets (ARCHITECTURE §5).
 */
import { eq, sql } from 'drizzle-orm';
import type { ServerSettings } from '@maily/shared';
import { db } from './client.js';
import { appSettings } from './schema.js';

/** Well-known key under which the client-owned prefs object lives. */
const PREFS_KEY = 'prefs';

/** Key of the server settings document. Migration 0030's cleanup-version triggers name it too. */
export const SERVER_SETTINGS_KEY = 'server.settings';

const SERVER_SETTINGS_DEFAULTS: ServerSettings = {
  cleanupProtectedKeywords: [],
  cleanupNewsletterKeywords: [],
  cleanupColdKeepKeywords: [],
  undoSendSeconds: 10,
};

const KEYWORD_LIST_KEYS = [
  'cleanupProtectedKeywords',
  'cleanupNewsletterKeywords',
  'cleanupColdKeepKeywords',
] as const;

/** The server settings that are cleanup keyword lists. */
export type KeywordListKey = (typeof KEYWORD_LIST_KEYS)[number];

const MAX_KEYWORDS = 500;
const MAX_KEYWORD_LENGTH = 100;
const MAX_UNDO_SEND_SECONDS = 300;

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

/** A stored JSON object, or `{}` when absent, unparseable or not an object. */
function getObject(key: string): Record<string, unknown> {
  const value = getSetting<unknown>(key, {});
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The stored prefs object, or `{}` when nothing has been saved yet. */
export function getPrefs(): Record<string, unknown> {
  return getObject(PREFS_KEY);
}

/**
 * Apply a top-level merge patch to the prefs object: each key replaces its stored value
 * wholesale and `null` removes it. Server settings keys are dropped, so a client that predates
 * the split can't recreate them in the blob.
 */
export function patchPrefs(patch: Record<string, unknown>): void {
  db.transaction(() => {
    const next = getPrefs();
    for (const [key, value] of Object.entries(patch)) {
      if (Object.hasOwn(SERVER_SETTINGS_DEFAULTS, key)) continue;
      if (value === null) delete next[key];
      else next[key] = value;
    }
    putSetting(PREFS_KEY, next);
  });
}

/**
 * Lowercase, trim, drop double quotes (they'd break the FTS phrase wrapper the cleanup slices
 * build) and de-dupe. Anything that isn't a list of strings becomes an empty list, which means
 * "use the built-ins".
 */
function normalizeKeywords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const x of raw) {
    if (typeof x !== 'string') continue;
    const term = x.trim().toLowerCase().replace(/"/g, '');
    if (term) out.add(term);
  }
  return [...out];
}

function isUndoSendSeconds(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_UNDO_SEND_SECONDS
  );
}

function isKeywordListKey(key: string): key is KeywordListKey {
  return (KEYWORD_LIST_KEYS as readonly string[]).includes(key);
}

/** The stored server settings with defaults filled in. A garbled value falls back per key. */
export function getServerSettings(): ServerSettings {
  const stored = getObject(SERVER_SETTINGS_KEY);
  return {
    cleanupProtectedKeywords: normalizeKeywords(stored.cleanupProtectedKeywords),
    cleanupNewsletterKeywords: normalizeKeywords(stored.cleanupNewsletterKeywords),
    cleanupColdKeepKeywords: normalizeKeywords(stored.cleanupColdKeepKeywords),
    undoSendSeconds: isUndoSendSeconds(stored.undoSendSeconds)
      ? stored.undoSendSeconds
      : SERVER_SETTINGS_DEFAULTS.undoSendSeconds,
  };
}

/**
 * Validate a partial update from the client. An unknown key or a wrong type rejects the whole
 * request, so a bad value never half-applies.
 */
export function parseServerSettingsPatch(
  body: unknown,
): { patch: Partial<ServerSettings> } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'settings object required' };
  }
  const patch: Partial<ServerSettings> = {};
  for (const [key, value] of Object.entries(body)) {
    if (isKeywordListKey(key)) {
      const valid =
        Array.isArray(value) &&
        value.length <= MAX_KEYWORDS &&
        value.every((t) => typeof t === 'string' && t.length <= MAX_KEYWORD_LENGTH);
      if (!valid) {
        return {
          error: `${key} must be a list of up to ${MAX_KEYWORDS} words of at most ${MAX_KEYWORD_LENGTH} characters`,
        };
      }
      patch[key] = normalizeKeywords(value);
    } else if (key === 'undoSendSeconds') {
      if (!isUndoSendSeconds(value)) {
        return {
          error: `undoSendSeconds must be a whole number from 0 to ${MAX_UNDO_SEND_SECONDS}`,
        };
      }
      patch.undoSendSeconds = value;
    } else {
      return { error: `unknown setting: ${key}` };
    }
  }
  return { patch };
}

/** Merge a validated patch into the stored server settings and return the result. */
export function patchServerSettings(patch: Partial<ServerSettings>): ServerSettings {
  return db.transaction(() => {
    const next = { ...getServerSettings(), ...patch };
    putSetting(SERVER_SETTINGS_KEY, next);
    return next;
  });
}
