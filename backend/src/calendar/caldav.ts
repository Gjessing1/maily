/**
 * Minimal Radicale CalDAV client — a dormant building block for the future calendar
 * integration (ROADMAP Phase 4 follow-up). Hand-rolled over `fetch`, mirroring the lean
 * CardDAV transport in `../contacts/carddav.ts` (no CalDAV dependency): serialise a
 * VEVENT-shaped draft (`./vevent.ts`) and `PUT` it as `<uid>.ics` into the configured
 * calendar collection.
 *
 * **Human-in-the-loop only** (no auto-RSVP, no auto-add — ROADMAP guardrail). The write
 * is idempotent: the resource path derives from the supplied id, so a retry after a
 * transient failure overwrites in place rather than duplicating.
 *
 * Not wired to anything today (the Action Center that previously called it was removed);
 * `pushCalendarEvent` is kept ready for the calendar integration to come. V1 writes to
 * the single collection at `CALDAV_URL`; multi-calendar discovery + a target picker (the
 * CardDAV pattern) is a deliberate follow-up.
 */
import type { CalendarEventDraft } from '../pipeline/enrichers/travel.js';
import { createLogger } from '../logger.js';
import { env } from '../env.js';
import { buildCalendar, CalendarBuildError } from './vevent.js';

const log = createLogger('caldav');

/** Thrown for CalDAV write failures so the approve route can surface them (→ 502). */
export class CalDavError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type CalDavConfig = NonNullable<ReturnType<typeof env.caldav>>;

/** Basic-auth header for the configured CalDAV account (same Radicale secret as CardDAV). */
function authHeader(cfg: CalDavConfig): string {
  return `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64')}`;
}

/** Configured collection URL, guaranteed slash-terminated so event paths append cleanly. */
function collectionUrl(cfg: CalDavConfig): string {
  return cfg.url.endsWith('/') ? cfg.url : `${cfg.url}/`;
}

/** Absolute (or relative) `/m/:uuid` deep link to the source message for embedding. */
function deepLink(messageId: string): string {
  const path = `/m/${messageId}`;
  return env.publicUrl ? `${env.publicUrl}${path}` : path;
}

/**
 * Runtime guard: an opaque value is a usable `CalendarEventDraft`. Defends the write
 * path against a malformed payload (drafts may arrive as stored JSON). Exported for the
 * future calendar integration that drives `pushCalendarEvent`.
 */
export function isCalendarDraft(p: unknown): p is CalendarEventDraft {
  if (typeof p !== 'object' || p === null) return false;
  const d = p as Record<string, unknown>;
  return (
    typeof d.summary === 'string' &&
    (d.start === null || typeof d.start === 'string') &&
    (d.end === null || typeof d.end === 'string')
  );
}

/**
 * Serialise + PUT a calendar event to Radicale. The resource name (`<uid>.ics`) and the
 * VEVENT UID both derive from `eventId`, so the write is idempotent across retries.
 */
export async function pushCalendarEvent(
  cfg: CalDavConfig,
  eventId: string,
  messageId: string,
  draft: CalendarEventDraft,
): Promise<void> {
  const uid = `${eventId}@maily`;
  let body: string;
  try {
    body = buildCalendar({ uid, draft, sourceLink: deepLink(messageId) });
  } catch (err) {
    // A draft we can't render (e.g. no start date) is a 422, not a transport failure.
    if (err instanceof CalendarBuildError) throw new CalDavError(err.message, 422);
    throw err;
  }

  const url = new URL(`${eventId}.ics`, collectionUrl(cfg)).toString();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: authHeader(cfg),
        'Content-Type': 'text/calendar; charset=utf-8',
      },
      body,
    });
  } catch (err) {
    throw new CalDavError(`CalDAV PUT failed: ${(err as Error).message}`, 502);
  }
  if (!res.ok) throw new CalDavError(`CalDAV PUT returned ${res.status} ${res.statusText}`, 502);
  log.info(`pushed calendar event ${eventId} (${draft.source})`);
}
