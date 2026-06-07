/**
 * `ics` — deterministic calendar-invite enricher (ROADMAP Phase 4).
 *
 * Parses the `text/calendar` MIME part (RFC 5545 `VCALENDAR`/`VEVENT`) that Google
 * Calendar, Outlook and friends embed in invite mail — captured at ingest into
 * `messages.body_calendar` (the small-inline-part exception, ARCHITECTURE §4) and
 * exposed here as `message.bodyCalendar`. Each `VEVENT` is normalised to a flat,
 * search-friendly shape (the `result`, for provenance / index) and offered as one
 * `calendar_event` proposal — surfaced later by the Action Center and, on approval,
 * PUT to Radicale.
 *
 * **Format alignment, no translation layer (ROADMAP Phase 4):** the `text/calendar`
 * part *is* iCalendar, exactly what Radicale (CalDAV) stores, so the proposal payload
 * reuses the same VEVENT-shaped `CalendarEventDraft` the `travel` enricher emits —
 * one representation across email-side parse and the future CalDAV push.
 *
 * Classification: `operational` (it emits proposals), so the framework gates it to
 * Tier 0 (recent) mail — a deep backfill never surfaces a stale "add this meeting"
 * offer (ARCHITECTURE §14), and an ignored offer silently expires (proposals.ts).
 * Method discipline: only an actual invite (`REQUEST`/`PUBLISH`, or a part with no
 * `METHOD`) produces an offer — a `CANCEL`/`REPLY`/`COUNTER` never proposes an add.
 *
 * No LLM, no network: pure deterministic text parsing of the captured part.
 */
import type { Enricher, EnricherContext, EnricherResult, ProposalDraft } from '../types.js';
import type { CalendarEventDraft } from './travel.js';

/** A normalised calendar event parsed from one `VEVENT`. */
export interface CalendarInvite {
  /** The event UID (the iCalendar identity key), when present. */
  uid: string | null;
  /** SUMMARY — the event title. Defaults to "Event" when the VEVENT omits it. */
  summary: string;
  /** DTSTART as ISO 8601 (date-only for all-day; `…Z` when the source is UTC). */
  start: string | null;
  /** DTEND as ISO 8601, when present. */
  end: string | null;
  /** LOCATION free text, when present. */
  location: string | null;
  /** DESCRIPTION free text, when present. */
  description: string | null;
  /** Organizer display name (CN) or address, when present. */
  organizer: string | null;
  /** Whether DTSTART was a date (VALUE=DATE) — an all-day event. */
  allDay: boolean;
}

/** The enricher's persisted result: the VCALENDAR method + every parsed event. */
export interface IcsFacts {
  /** VCALENDAR METHOD (uppercased), e.g. REQUEST / CANCEL / PUBLISH; null when absent. */
  method: string | null;
  events: CalendarInvite[];
}

/** METHODs that represent an *invitation* — the only ones we offer to add. */
const INVITE_METHODS = new Set(['REQUEST', 'PUBLISH']);

interface ContentLine {
  name: string;
  params: Record<string, string>;
  value: string;
}

/**
 * Unfold an iCalendar stream into logical lines (RFC 5545 §3.1): a line beginning
 * with a space or HTAB is a continuation of the previous one. Tolerates CRLF, CR or
 * LF endings (the captured part may have been re-encoded along the way).
 */
function unfold(raw: string): string[] {
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (out.length > 0 && (line.startsWith(' ') || line.startsWith('\t'))) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Split on `sep`, ignoring separators inside double quotes (RFC 5545 quoted params). */
function splitUnquoted(s: string, sep: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inQuote = false;
  for (const ch of s) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === sep && !inQuote) {
      out.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  out.push(buf);
  return out;
}

/** Parse one unfolded line into NAME, params and value, or null if it has no value. */
function parseLine(line: string): ContentLine | null {
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ':' && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const segs = splitUnquoted(line.slice(0, colon), ';');
  const name = (segs.shift() ?? '').trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const seg of segs) {
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    params[seg.slice(0, eq).trim().toUpperCase()] = seg
      .slice(eq + 1)
      .trim()
      .replace(/^"|"$/g, '');
  }
  return { name, params, value: line.slice(colon + 1) };
}

/** Unescape an iCalendar TEXT value (RFC 5545 §3.3.11): \n \, \; \\ . */
function unescapeText(v: string): string {
  let out = '';
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (ch === '\\' && i + 1 < v.length) {
      const next = v[++i];
      out += next === 'n' || next === 'N' ? '\n' : next;
    } else {
      out += ch;
    }
  }
  return out.trim();
}

/** Whether a DTSTART/DTEND is a calendar date (all-day) rather than a date-time. */
function isDateValue(value: string, params: Record<string, string>): boolean {
  return params.VALUE === 'DATE' || /^\d{8}$/.test(value.trim());
}

/** Convert an iCalendar DATE / DATE-TIME to ISO 8601, or null if unrecognised. */
function toIso(value: string, params: Record<string, string>): string | null {
  const v = value.trim();
  if (!v) return null;
  if (isDateValue(v, params)) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }
  // DATE-TIME: a trailing Z marks UTC; a TZID-only time is kept naive (we carry no
  // tz database, so we never fabricate an offset) — RFC 5545 floating/local time.
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return null;
  const base = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  return m[7] ? `${base}Z` : base;
}

/** Best organizer label: the CN param, else the address (mailto: stripped). */
function organizerLabel(line: ContentLine): string | null {
  const cn = line.params.CN?.trim();
  if (cn) return cn;
  const addr = line.value.trim().replace(/^mailto:/i, '');
  return addr || null;
}

type DraftEvent = Partial<CalendarInvite>;

function finalize(e: DraftEvent): CalendarInvite {
  return {
    uid: e.uid ?? null,
    summary: e.summary?.trim() || 'Event',
    start: e.start ?? null,
    end: e.end ?? null,
    location: e.location ?? null,
    description: e.description ?? null,
    organizer: e.organizer ?? null,
    allDay: e.allDay ?? false,
  };
}

/**
 * Parse a raw iCalendar string into its METHOD and VEVENTs. A component stack tracks
 * nesting so a nested VALARM's own SUMMARY/DESCRIPTION can never be mistaken for the
 * event's: properties are only read while the innermost open component is the VEVENT.
 */
export function parseCalendar(raw: string): IcsFacts {
  const stack: string[] = [];
  const events: CalendarInvite[] = [];
  let method: string | null = null;
  let cur: DraftEvent | null = null;

  for (const line of unfold(raw)) {
    const cl = parseLine(line);
    if (!cl) continue;

    if (cl.name === 'BEGIN') {
      const comp = cl.value.trim().toUpperCase();
      stack.push(comp);
      if (comp === 'VEVENT') cur = {};
      continue;
    }
    if (cl.name === 'END') {
      const ended = stack.pop();
      if (ended === 'VEVENT' && cur) {
        events.push(finalize(cur));
        cur = null;
      }
      continue;
    }

    const inner = stack[stack.length - 1];
    if (cl.name === 'METHOD' && inner === 'VCALENDAR') {
      method = cl.value.trim().toUpperCase() || null;
      continue;
    }
    if (!cur || inner !== 'VEVENT') continue;

    switch (cl.name) {
      case 'UID':
        cur.uid = cl.value.trim() || null;
        break;
      case 'SUMMARY':
        cur.summary = unescapeText(cl.value);
        break;
      case 'LOCATION':
        cur.location = unescapeText(cl.value) || null;
        break;
      case 'DESCRIPTION':
        cur.description = unescapeText(cl.value) || null;
        break;
      case 'DTSTART':
        cur.start = toIso(cl.value, cl.params);
        cur.allDay = isDateValue(cl.value, cl.params);
        break;
      case 'DTEND':
        cur.end = toIso(cl.value, cl.params);
        break;
      case 'ORGANIZER':
        cur.organizer = organizerLabel(cl);
        break;
      default:
        break;
    }
  }
  return { method, events };
}

/** Build the VEVENT-shaped calendar offer from a parsed invite. */
function toCalendarDraft(e: CalendarInvite): CalendarEventDraft {
  const desc = [e.description, e.organizer ? `Organizer: ${e.organizer}` : null]
    .filter(Boolean)
    .join('\n');
  return {
    summary: e.summary,
    start: e.start,
    end: e.end,
    location: e.location,
    description: desc || null,
    source: 'invite',
  };
}

/** An event worth offering carries at least a title or a start time. */
function hasSubstance(e: CalendarInvite): boolean {
  return Boolean(e.start) || e.summary !== 'Event';
}

export const icsEnricher: Enricher = {
  name: 'ics',
  version: 1,
  kind: 'operational',
  // Cheap gate: only mail with a captured calendar part carrying a VEVENT applies.
  applies(message) {
    return Boolean(message.bodyCalendar && message.bodyCalendar.includes('BEGIN:VEVENT'));
  },
  run(ctx: EnricherContext): EnricherResult {
    const raw = ctx.message.bodyCalendar;
    if (!raw) return {};

    const facts = parseCalendar(raw);
    // Offer only genuine invitations (or a method-less part); a cancellation/reply
    // is recorded for provenance but never proposes an add.
    const offerable =
      facts.method === null || INVITE_METHODS.has(facts.method)
        ? facts.events.filter(hasSubstance)
        : [];

    const proposals: ProposalDraft[] = offerable.map((e) => ({
      type: 'calendar_event',
      title: e.summary,
      payload: toCalendarDraft(e),
    }));

    return { result: facts, proposals };
  },
};
