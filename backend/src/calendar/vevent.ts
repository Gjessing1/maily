/**
 * iCalendar (RFC 5545) VEVENT serialiser — the write side of the **one representation**
 * the ICS enricher reads (`enrichers/ics.ts`). A `calendar_event` proposal carries a
 * VEVENT-shaped `CalendarEventDraft`; on approval we turn it back into a VCALENDAR/VEVENT
 * and `PUT` it to Radicale (`caldav.ts`). Pure (no I/O) so it's unit-testable; the
 * transport layer lives in `caldav.ts`, mirroring the contacts split (`vcard.ts` ⇄
 * `carddav.ts`).
 *
 * Date handling matches what the parser produced (`ics.ts` `toIso`):
 *   - date-only `YYYY-MM-DD`     → all-day `;VALUE=DATE:YYYYMMDD`
 *   - floating `…THH:MM[:SS]`    → naive local `YYYYMMDDTHHMMSS` (no Z — we carry no tz
 *                                  database, so we never fabricate an offset)
 *   - zoned   `…Z` / `…±HH:MM`   → normalised to UTC `YYYYMMDDTHHMMSSZ`
 * so an invite round-trips faithfully (UTC stays UTC, floating stays floating, all-day
 * stays all-day) rather than being shifted by the server's timezone.
 */
import type { CalendarEventDraft } from '../pipeline/enrichers/travel.js';

export interface BuildEventInput {
  /** Stable VEVENT UID. Re-PUTting the same UID updates the event in place (idempotent). */
  uid: string;
  draft: CalendarEventDraft;
  /** Deep link back to the source message (`/m/:uuid`, absolute when MAILY_PUBLIC_URL set). */
  sourceLink: string | null;
  /** DTSTAMP instant; injectable so tests are deterministic. Defaults to now. */
  now?: Date;
}

/** Thrown when a draft can't form a valid VEVENT (e.g. no start date). */
export class CalendarBuildError extends Error {}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const FLOATING = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

const pad = (n: number): string => String(n).padStart(2, '0');

/** Compact UTC form `YYYYMMDDTHHMMSSZ`. */
function utcStamp(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * Render one ISO date/date-time as an iCalendar property value + any params (the
 * `;VALUE=DATE` marker for all-day). Returns null when the string is unparseable.
 */
function icalDate(iso: string): { params: string; value: string } | null {
  const s = iso.trim();
  if (!s) return null;

  const dateOnly = DATE_ONLY.exec(s);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    return { params: ';VALUE=DATE', value: `${y}${mo}${d}` };
  }

  const floating = FLOATING.exec(s);
  if (floating) {
    const [, y, mo, d, h, mi, se = '00'] = floating;
    return { params: '', value: `${y}${mo}${d}T${h}${mi}${se}` };
  }

  // Anything else carries an explicit zone (Z or ±HH:MM) — normalise to UTC.
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) return null;
  return { params: '', value: utcStamp(dt) };
}

/** Escape an iCalendar TEXT value (RFC 5545 §3.3.11): backslash, newline, comma, semicolon. */
function escapeText(v: string): string {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\n|\r/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

/**
 * Fold a content line to ≤75 octets (RFC 5545 §3.1): continuation lines begin with a
 * single space. We fold by UTF-8 byte length and never split a multi-byte char.
 */
function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  let first = true;
  for (const ch of line) {
    const chBytes = enc.encode(ch).length;
    // Continuation lines lose one octet to the leading space.
    const limit = first ? 75 : 74;
    if (curBytes + chBytes > limit) {
      out.push(cur);
      cur = ch;
      curBytes = chBytes;
      first = false;
    } else {
      cur += ch;
      curBytes += chBytes;
    }
  }
  out.push(cur);
  return out.join('\r\n ');
}

/** Whether the link is an absolute http(s) URL (worth emitting as a URL property). */
function isAbsoluteHttp(link: string): boolean {
  return /^https?:\/\//i.test(link);
}

/**
 * Build a complete VCALENDAR wrapping one VEVENT from a proposal draft. Throws
 * `CalendarBuildError` when the draft has no start (a VEVENT requires DTSTART and we
 * won't invent a date). Lines are CRLF-terminated and folded per RFC 5545.
 */
export function buildCalendar(input: BuildEventInput): string {
  const { uid, draft, sourceLink } = input;
  const now = input.now ?? new Date();

  if (!draft.start) {
    throw new CalendarBuildError('calendar event draft has no start date');
  }
  const start = icalDate(draft.start);
  if (!start) {
    throw new CalendarBuildError(`unparseable start date: ${draft.start}`);
  }
  const end = draft.end ? icalDate(draft.end) : null;

  // Fold the source link into the human description so it survives in any calendar
  // client; emit a machine URL property too when it's an absolute link.
  const descParts: string[] = [];
  if (draft.description) descParts.push(draft.description);
  if (sourceLink) descParts.push(`Source: ${sourceLink}`);
  const description = descParts.join('\n');

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//maily//calendar//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${escapeText(uid)}`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART${start.params}:${start.value}`,
  ];
  if (end) lines.push(`DTEND${end.params}:${end.value}`);
  lines.push(`SUMMARY:${escapeText(draft.summary || 'Event')}`);
  if (draft.location) lines.push(`LOCATION:${escapeText(draft.location)}`);
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
  if (sourceLink && isAbsoluteHttp(sourceLink)) lines.push(`URL:${escapeText(sourceLink)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');

  return lines.map(fold).join('\r\n') + '\r\n';
}
