/**
 * "Add to calendar" sheet for the reader: turns the open message into a Radicale
 * event. The form is pre-filled from the message's enrichment drafts (a parsed
 * invite or a travel reservation when present, else the bare subject) and offers
 * a calendar picker over the discovered CalDAV collections (the server default
 * pre-selected). Dates behave like a calendar app: an event is same-day unless the
 * draft says otherwise, and moving the start drags the end along.
 * Human-in-the-loop by design: nothing is written until Add.
 */
import { useEffect, useState } from 'react';
import type { CalendarSettingsDto, EventDraftDto } from '@maily/shared';
import { api } from '../api/client';
import { Spinner } from '../ui/Spinner';

interface Props {
  messageId: string;
  onClose: () => void;
}

/** Friendly chip label for a draft's provenance. */
const SOURCE_LABELS: Record<EventDraftDto['source'], string> = {
  invite: 'Invite',
  flight: 'Flight',
  lodging: 'Stay',
  event: 'Ticket',
  message: 'Blank',
};

const pad = (n: number): string => String(n).padStart(2, '0');
const localDate = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * Split a draft's ISO date/date-time into form fields. Zoned stamps (Z/±HH:MM)
 * are shown as local wall-clock time; floating ones are taken verbatim.
 */
function splitIso(iso: string | null): { date: string; time: string; allDay: boolean } {
  if (!iso) return { date: localDate(new Date()), time: '', allDay: false };
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return { date: iso, time: '', allDay: true };
  const floating = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  if (floating && !/[Zz]|[+-]\d{2}:\d{2}$/.test(iso)) {
    return { date: floating[1]!, time: floating[2]!, allDay: false };
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: localDate(new Date()), time: '', allDay: false };
  return { date: localDate(d), time: localTime(d), allDay: false };
}

/** Shift a `YYYY-MM-DD` date by whole days (all-day DTEND is exclusive: ±1). */
function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * A `YYYY-MM-DD` + `HH:MM` pair as minutes on a fixed timeline, so start/end
 * arithmetic is plain subtraction. UTC on purpose: these are wall-clock form
 * fields, and a DST jump must not silently stretch or shrink the duration.
 */
function toMinutes(date: string, time: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{1,2}):(\d{2})/.exec(time || '00:00');
  if (!d || !t) return null;
  return Date.UTC(+d[1]!, +d[2]! - 1, +d[3]!, +t[1]!, +t[2]!) / 60_000;
}

/** Inverse of `toMinutes`. */
function fromMinutes(minutes: number): { date: string; time: string } {
  const d = new Date(minutes * 60_000);
  return {
    date: d.toISOString().slice(0, 10),
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
}

/** Fallback end for a start the draft gave no end for: same day, an hour later. */
const DEFAULT_DURATION_MIN = 60;
function defaultEnd(date: string, time: string): { date: string; time: string } {
  const from = toMinutes(date, time);
  return from === null ? { date, time } : fromMinutes(from + DEFAULT_DURATION_MIN);
}

export function AddToCalendar({ messageId, onClose }: Props) {
  const [calendars, setCalendars] = useState<CalendarSettingsDto | null>(null);
  const [drafts, setDrafts] = useState<EventDraftDto[] | null>(null);
  const [draftIdx, setDraftIdx] = useState(0);

  const [calendar, setCalendar] = useState<string>('');
  const [summary, setSummary] = useState('');
  const [allDay, setAllDay] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  /**
   * Seed the form from one draft suggestion. The end is never left blank: a draft
   * without one becomes a same-day event (an hour long when timed), which is what
   * the form would otherwise make the user type on every add.
   */
  function applyDraft(d: EventDraftDto) {
    const start = splitIso(d.start);
    const startAt = start.time || '09:00';
    const end = d.end ? splitIso(d.end) : null;
    setSummary(d.summary);
    setAllDay(start.allDay);
    setStartDate(start.date);
    setStartTime(startAt);
    if (end && start.allDay) {
      // An all-day DTEND is exclusive; "Ends" here is the inclusive last day.
      setEndDate(end.date > start.date ? shiftDays(end.date, -1) : start.date);
      setEndTime(defaultEnd(start.date, startAt).time);
    } else if (end && end.time) {
      setEndDate(end.date);
      setEndTime(end.time);
    } else {
      const fallback = defaultEnd(start.date, startAt);
      setEndDate(end ? end.date : fallback.date);
      setEndTime(fallback.time);
    }
    setLocation(d.location ?? '');
    setDescription(d.description ?? '');
  }

  /**
   * Move the start, dragging the end along so the duration is preserved — the
   * calendar-app convention, and what keeps a same-day event same-day when the
   * start moves. Manual edits to the end fields stand on their own.
   */
  function moveStart(date: string, time: string) {
    setStartDate(date);
    setStartTime(time);
    const before = toMinutes(startDate, allDay ? '00:00' : startTime);
    const after = toMinutes(date, allDay ? '00:00' : time);
    const end = toMinutes(endDate, allDay ? '00:00' : endTime);
    if (before === null || after === null || end === null) {
      setEndDate(date);
      return;
    }
    const shifted = fromMinutes(end + (after - before));
    setEndDate(shifted.date);
    if (!allDay) setEndTime(shifted.time);
  }

  useEffect(() => {
    let alive = true;
    Promise.all([api.calendars(), api.eventDrafts(messageId)])
      .then(([cals, ds]) => {
        if (!alive) return;
        setCalendars(cals);
        setCalendar(cals.default ?? '');
        setDrafts(ds);
        if (ds[0]) applyDraft(ds[0]);
      })
      .catch((e) => alive && setError((e as Error).message || 'Couldn’t load calendars.'));
    return () => {
      alive = false;
    };
  }, [messageId]);

  const pickDraft = (i: number) => {
    setDraftIdx(i);
    const d = drafts?.[i];
    if (d) applyDraft(d);
  };

  async function save() {
    if (!summary.trim()) {
      setError('Add a title.');
      return;
    }
    if (!startDate) {
      setError('Pick a start date.');
      return;
    }
    const startMin = toMinutes(startDate, allDay ? '00:00' : startTime);
    const endMin = toMinutes(endDate || startDate, allDay ? '00:00' : endTime);
    if (startMin !== null && endMin !== null && endMin < startMin) {
      setError('The end can’t be before the start.');
      return;
    }
    // All-day "Ends" is the inclusive last day in the form; iCalendar DTEND is
    // exclusive, so shift it one day (and drop a same-day end entirely).
    const start = allDay ? startDate : `${startDate}T${startTime || '00:00'}`;
    let end: string | null = null;
    if (allDay) {
      if (endDate && endDate > startDate) end = shiftDays(endDate, 1);
    } else if (endTime) {
      end = `${endDate || startDate}T${endTime}`;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.addToCalendar(messageId, {
        calendar: calendar || null,
        summary: summary.trim(),
        start,
        end,
        location: location.trim() || null,
        description: description.trim() || null,
      });
      const name =
        calendars?.calendars.find((c) => c.href === res.calendar)?.displayName ?? 'calendar';
      setAdded(name);
      setTimeout(onClose, 900);
    } catch (e) {
      setError((e as Error).message || 'Couldn’t add the event.');
      setBusy(false);
    }
  }

  const loading = calendars === null || drafts === null;
  const noCalendars = calendars !== null && calendars.calendars.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        aria-label="Cancel"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />
      <div className="safe-bottom relative flex max-h-[92vh] w-full max-w-md flex-col rounded-t-2xl border border-border bg-bg shadow-xl sm:rounded-2xl">
        <h2 className="border-b border-border px-5 py-4 text-base font-semibold text-fg">
          Add to calendar
        </h2>

        <div className="flex-1 overflow-y-auto px-5 py-4 no-scrollbar">
          {loading && !error ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : noCalendars ? (
            <p className="py-4 text-sm text-faint">
              No calendars found. Configure CalDAV on the server to add events.
            </p>
          ) : (
            <>
              {drafts && drafts.length > 1 && (
                <div className="mb-1 flex flex-wrap gap-1.5">
                  {drafts.map((d, i) => (
                    <button
                      key={i}
                      onClick={() => pickDraft(i)}
                      aria-pressed={i === draftIdx}
                      className={`rounded-full px-2.5 py-1 text-xs ${
                        i === draftIdx
                          ? 'bg-accent text-white'
                          : 'bg-surface-2 text-faint active:bg-surface-3'
                      }`}
                    >
                      {SOURCE_LABELS[d.source]}
                    </button>
                  ))}
                </div>
              )}

              <Field label="Title">
                <input
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder="Event title"
                  className={inputCls}
                />
              </Field>

              {calendars && calendars.calendars.length > 1 && (
                <Field label="Calendar">
                  <select
                    value={calendar}
                    onChange={(e) => setCalendar(e.target.value)}
                    className={inputCls}
                  >
                    {calendars.calendars.map((c) => (
                      <option key={c.href} value={c.href}>
                        {c.displayName}
                      </option>
                    ))}
                  </select>
                </Field>
              )}

              <label className="mt-4 flex items-center justify-between">
                <span className="text-[15px]">All-day</span>
                <input
                  type="checkbox"
                  checked={allDay}
                  onChange={(e) => setAllDay(e.target.checked)}
                  className="size-5 accent-accent"
                />
              </label>

              <div className="flex gap-2">
                <Field label="Starts" className="flex-1">
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => moveStart(e.target.value, startTime)}
                    className={inputCls}
                  />
                </Field>
                {!allDay && (
                  <Field label="Time" className="w-32">
                    <input
                      type="time"
                      value={startTime}
                      onChange={(e) => moveStart(startDate, e.target.value)}
                      className={inputCls}
                    />
                  </Field>
                )}
              </div>

              <div className="flex gap-2">
                <Field label="Ends" className="flex-1">
                  <input
                    type="date"
                    value={endDate}
                    min={startDate || undefined}
                    onChange={(e) => setEndDate(e.target.value)}
                    className={inputCls}
                  />
                </Field>
                {!allDay && (
                  <Field label="Time" className="w-32">
                    <input
                      type="time"
                      value={endTime}
                      onChange={(e) => setEndTime(e.target.value)}
                      className={inputCls}
                    />
                  </Field>
                )}
              </div>

              <Field label="Location">
                <input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="Where"
                  className={inputCls}
                />
              </Field>

              <Field label="Notes">
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  placeholder="Notes"
                  className={`${inputCls} resize-y`}
                />
              </Field>
            </>
          )}

          {error && <p className="mt-3 text-sm text-danger">{error}</p>}
          {added && <p className="mt-3 text-sm text-accent">Added to {added}.</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button
            onClick={onClose}
            disabled={busy && !added}
            className="rounded-full px-4 py-2 text-sm text-fg active:bg-surface-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy || loading || noCalendars}
            className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {added ? 'Added' : busy ? 'Adding…' : 'Add event'}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  'min-w-0 flex-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-[15px] text-fg outline-none focus:border-accent';

function Field({
  label,
  className = '',
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`mt-4 block first:mt-0 ${className}`}>
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-faint">
        {label}
      </span>
      {children}
    </label>
  );
}
