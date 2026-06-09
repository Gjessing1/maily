/**
 * Calendar integration (Radicale CalDAV): discovered-calendar settings + the
 * reader's "Add to calendar" action. Human-in-the-loop only — every event write
 * is an explicit user confirm; nothing is auto-added (ROADMAP guardrail).
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { CalendarEventInput, CalendarSettingsDto, EventDraftDto } from '@maily/shared';
import { env } from '../../env.js';
import { getMessage } from '../../db/queries.js';
import {
  ensureCalendarsDiscovered,
  effectiveDefault,
  getCalendarState,
  getDiscovered,
  setDefaultCalendar,
} from '../../calendar/calendars.js';
import { eventDraftsForMessage } from '../../calendar/drafts.js';
import { CalDavError, pushCalendarEvent } from '../../calendar/caldav.js';
import type { CalendarEventDraft } from '../../pipeline/enrichers/travel.js';

/**
 * Stable event id for the CalDAV resource: re-sending the identical payload (a
 * retry) overwrites in place, while a genuinely different event from the same
 * message (e.g. outbound + return flight) gets its own resource.
 */
function eventId(messageId: string, draft: CalendarEventDraft): string {
  return createHash('sha1')
    .update(`${messageId}\n${draft.start}\n${draft.summary}`)
    .digest('hex')
    .slice(0, 24);
}

export async function calendarRoutes(app: FastifyInstance): Promise<void> {
  // Discovered calendars + the default event target (empty when CalDAV is unset).
  app.get('/api/calendar/calendars', async (): Promise<CalendarSettingsDto> => {
    await ensureCalendarsDiscovered();
    return getCalendarState();
  });

  // Set the default target for new events.
  app.put<{ Body: { default?: string | null } }>('/api/calendar/calendars', async (req) => {
    await ensureCalendarsDiscovered();
    setDefaultCalendar(req.body?.default ? String(req.body.default) : null);
    return getCalendarState();
  });

  // Pre-fill suggestions for the "Add to calendar" form (best first, never empty).
  app.get<{ Params: { id: string } }>(
    '/api/messages/:id/event-drafts',
    async (req, reply): Promise<EventDraftDto[] | void> => {
      const m = getMessage(req.params.id);
      if (!m) return reply.code(404).send({ error: 'not found' });
      return eventDraftsForMessage(m);
    },
  );

  // Write one user-confirmed event to the chosen calendar (or the default).
  app.post<{ Params: { id: string }; Body: CalendarEventInput }>(
    '/api/messages/:id/calendar-event',
    async (req, reply) => {
      const cfg = env.caldav();
      if (!cfg) return reply.code(503).send({ error: 'CalDAV is not configured' });
      const m = getMessage(req.params.id);
      if (!m) return reply.code(404).send({ error: 'not found' });

      const summary = req.body?.summary?.toString().trim();
      const start = req.body?.start?.toString().trim();
      if (!summary) return reply.code(400).send({ error: 'summary required' });
      if (!start) return reply.code(400).send({ error: 'start required' });

      await ensureCalendarsDiscovered();
      const requested = req.body?.calendar ? String(req.body.calendar) : null;
      const calendar =
        requested && getDiscovered().some((c) => c.href === requested)
          ? requested
          : effectiveDefault();
      if (!calendar) return reply.code(503).send({ error: 'no calendar available' });

      const draft: CalendarEventDraft = {
        summary,
        start,
        end: req.body?.end?.toString().trim() || null,
        location: req.body?.location?.toString().trim() || null,
        description: req.body?.description?.toString().trim() || null,
        source: 'message',
      };
      try {
        await pushCalendarEvent(cfg, calendar, eventId(m.id, draft), m.id, draft);
      } catch (err) {
        const status = err instanceof CalDavError ? err.status : 502;
        return reply.code(status).send({ error: (err as Error).message });
      }
      return reply.code(201).send({ ok: true, calendar });
    },
  );
}
