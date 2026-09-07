/**
 * Calendar registry + default-target setting — the calendar twin of
 * `../contacts/addressbooks.ts`, but leaner: calendars are write targets only
 * (nothing syncs *from* them), so there is no active set — just the discovered
 * collections plus the user's **default** target for new events. The choice
 * persists server-side in `app_settings` under a dedicated key, separate from
 * the client-owned `prefs` blob.
 *
 * `default === null` means "never set" → the first discovered calendar. A stored
 * href that's no longer discovered falls back the same way, so a stale selection
 * can't target a removed calendar — *unless* discovery itself is degraded (see
 * below), where the user's stored choice is the better guess.
 */
import type { CalendarSettingsDto } from '@maily/shared';
import { getSetting, putSetting } from '../db/settings.js';
import { env } from '../env.js';
import { discoverCalendars } from './discover.js';

/** One CalDAV calendar collection. */
export interface Calendar {
  href: string;
  displayName: string;
}

const SETTINGS_KEY = 'calendar.calendars';

/** The most recently discovered calendars — refreshed lazily on demand. */
let discovered: Calendar[] = [];

/**
 * True while `discovered` holds the degraded single-URL fallback because discovery
 * failed. Caching that would be worse than not caching at all: one transient CalDAV
 * hiccup would drop the user's stored default and silently retarget every event for
 * the life of the process, so a degraded set is retried on the next call.
 */
let degraded = false;

export function setDiscovered(calendars: Calendar[]): void {
  discovered = calendars;
  degraded = false;
}

export function getDiscovered(): Calendar[] {
  return discovered;
}

/** Ensure the discovered calendar set is populated (lazy, for the API routes). */
export async function ensureCalendarsDiscovered(): Promise<void> {
  const cfg = env.caldav();
  if (!cfg || (discovered.length > 0 && !degraded)) return;
  const found = await discoverCalendars(cfg);
  setDiscovered(found ?? [{ href: cfg.url, displayName: 'Calendar' }]);
  degraded = found === null;
}

/** The event target: the stored default if still discovered, else the first calendar. */
export function effectiveDefault(): string | null {
  const stored = getSetting<{ default?: string | null }>(SETTINGS_KEY, {}).default ?? null;
  // While discovery is degraded we know nothing about which calendars exist, so the
  // stored choice beats the fallback URL (which isn't even a calendar collection).
  if (stored && (degraded || discovered.some((c) => c.href === stored))) return stored;
  return discovered[0]?.href ?? null;
}

/** Persist the default event target. */
export function setDefaultCalendar(def: string | null): void {
  putSetting(SETTINGS_KEY, { default: def });
}

/** Current state for the API: discovered calendars + the resolved default. */
export function getCalendarState(): CalendarSettingsDto {
  return { calendars: discovered, default: effectiveDefault() };
}
