/**
 * Minimal Radicale CalDAV client — the approve-time side effect for `calendar_event`
 * proposals (ROADMAP Phase 4: "Radicale CalDAV push on approval"). Hand-rolled over
 * `fetch`, mirroring the lean CardDAV transport in `../contacts/carddav.ts` (no CalDAV
 * dependency). On approval the Action Center route (`routes/api/actions.ts`) looks up
 * the handler registered here and runs it: serialise the proposal's VEVENT-shaped draft
 * (`./vevent.ts`) and `PUT` it as `<uid>.ics` into the configured calendar collection.
 *
 * **Human-in-the-loop only** (the user approved) — there is no auto-RSVP and no
 * auto-add (ROADMAP guardrail). The write is idempotent: the resource path derives from
 * the proposal id, so a retry after a transient failure overwrites in place rather than
 * duplicating. The same flow serves both travel reservations and parsed email invites
 * (one representation, per the ICS item) — RSVP/add-to-calendar is just this approve.
 *
 * V1 writes events to the single collection at `CALDAV_URL`; multi-calendar discovery +
 * a target picker (the CardDAV pattern) is a deliberate follow-up.
 */
import type { CalendarEventDraft } from '../pipeline/enrichers/travel.js';
import { createLogger } from '../logger.js';
import { env } from '../env.js';
import { registerApproveHandler, type ApproveContext } from '../pipeline/proposal-handlers.js';
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
 * Runtime guard: the parsed proposal payload is a usable `CalendarEventDraft`. Defends
 * the write path against a malformed/legacy row (the payload is stored as opaque JSON).
 */
function isCalendarDraft(p: unknown): p is CalendarEventDraft {
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
 * VEVENT UID both derive from `proposalId`, so the write is idempotent across retries.
 */
export async function pushCalendarEvent(
  cfg: CalDavConfig,
  proposalId: string,
  messageId: string,
  draft: CalendarEventDraft,
): Promise<void> {
  const uid = `${proposalId}@maily`;
  let body: string;
  try {
    body = buildCalendar({ uid, draft, sourceLink: deepLink(messageId) });
  } catch (err) {
    // A draft we can't render (e.g. no start date) is a 422, not a transport failure.
    if (err instanceof CalendarBuildError) throw new CalDavError(err.message, 422);
    throw err;
  }

  const url = new URL(`${proposalId}.ics`, collectionUrl(cfg)).toString();
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
  log.info(`pushed calendar event for proposal ${proposalId} (${draft.source})`);
}

/** The approve side effect for `calendar_event`: push the draft to Radicale. */
async function handleApprove(ctx: ApproveContext): Promise<void> {
  const cfg = env.caldav();
  if (!cfg) throw new CalDavError('CalDAV is not configured', 503);
  if (!isCalendarDraft(ctx.payload)) {
    throw new CalDavError('proposal payload is not a calendar event draft', 422);
  }
  await pushCalendarEvent(cfg, ctx.id, ctx.messageId, ctx.payload);
}

/**
 * Register the `calendar_event` approve handler — but only when CalDAV is configured.
 * Unconfigured, the type stays handler-less, so approving an offer just acknowledges it
 * with no external write (proposal-handlers.ts), rather than failing every approval.
 */
export function registerCalendarApproveHandler(): void {
  if (!env.caldav()) {
    log.info('CalDAV not configured (CALDAV_URL/USER/PASSWORD) — calendar push disabled');
    return;
  }
  registerApproveHandler('calendar_event', handleApprove);
  log.info('calendar_event approve handler registered (Radicale CalDAV push)');
}
