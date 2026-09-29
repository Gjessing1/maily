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
 *
 * The discovered set goes stale when calendars are added, restored or removed on
 * the server, so a good result is only trusted for `MAX_AGE_MS`, and Settings can
 * force a rediscovery (`refreshCalendars`).
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

/** How long a good discovery is trusted before the next read rediscovers. */
const MAX_AGE_MS = 10 * 60 * 1000;

/** The most recently discovered calendars — refreshed lazily on demand. */
let discovered: Calendar[] = [];

/** When `discovered` was last set from a successful discovery (epoch ms). */
let discoveredAt = 0;

/**
 * True while `discovered` holds the degraded single-URL fallback because discovery
 * failed. Caching that would be worse than not caching at all: one transient CalDAV
 * hiccup would drop the user's stored default and silently retarget every event for
 * the life of the process, so a degraded set is retried on the next call.
 */
let degraded = false;

export function setDiscovered(calendars: Calendar[]): void {
  discovered = calendars;
  discoveredAt = Date.now();
  degraded = false;
}

export function getDiscovered(): Calendar[] {
  return discovered;
}

/**
 * Run discovery. A failure never replaces a good set with the fallback — the last
 * real calendars beat a URL that isn't even a collection — and leaves
 * `discoveredAt` alone, so the next read tries again.
 */
async function discover(cfg: NonNullable<ReturnType<typeof env.caldav>>): Promise<void> {
  const found = await discoverCalendars(cfg);
  if (found) {
    setDiscovered(found);
    return;
  }
  if (discovered.length > 0 && !degraded) return;
  discovered = [{ href: cfg.url, displayName: 'Calendar' }];
  degraded = true;
}

/** Ensure the discovered calendar set is populated and fresh (lazy, for the API routes). */
export async function ensureCalendarsDiscovered(): Promise<void> {
  const cfg = env.caldav();
  if (!cfg) return;
  const fresh = !degraded && discovered.length > 0 && Date.now() - discoveredAt < MAX_AGE_MS;
  if (!fresh) await discover(cfg);
}

/** Rediscover now, regardless of age — the Settings "Refresh" action. */
export async function refreshCalendars(): Promise<void> {
  const cfg = env.caldav();
  if (cfg) await discover(cfg);
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
