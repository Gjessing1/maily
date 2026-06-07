/**
 * Trip History (ROADMAP Phase 4). A read-only travel timeline over the pipeline's
 * `travel` enricher — flights, stays and events grouped into trips, newest-first, each
 * row deep-linking to its source message (`/m/:id`). *Pure retrieval*: this is something
 * you browse/search, never a stale "add to calendar" nudge (that operational offer lives
 * in the Action Center and only fires on recent mail). An empty list is fine, not a chore.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { TripDto, TripReservationDto } from '@maily/shared';
import { api } from '../api/client';
import { Spinner } from '../ui/Spinner';
import { BackIcon, CalendarIcon, ClockIcon, MapPinIcon, PackageIcon } from '../ui/icons';

const RES_META: Record<TripReservationDto['type'], { label: string; Icon: typeof MapPinIcon }> = {
  flight: { label: 'Flight', Icon: PackageIcon },
  lodging: { label: 'Stay', Icon: MapPinIcon },
  event: { label: 'Event', Icon: CalendarIcon },
};

/** A single calendar date, locale-formatted (no time — a trip is a span of days). */
function day(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A trip's date span, collapsing a single-day or unknown range. */
function spanLabel(startsAt: string | null, endsAt: string | null): string {
  const a = day(startsAt);
  const b = day(endsAt);
  if (!a && !b) return 'Dates unknown';
  if (!b || a === b) return a || b;
  return `${a} – ${b}`;
}

function ReservationRow({ r }: { r: TripReservationDto }) {
  const { label, Icon } = RES_META[r.type];
  return (
    <Link
      to={`/m/${r.messageId}`}
      className="flex items-start gap-3 rounded-lg px-3 py-2.5 active:bg-surface-2"
    >
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-surface text-faint">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-[15px] font-medium text-fg">{r.title}</span>
          <span className="shrink-0 text-xs uppercase tracking-wide text-faint">{label}</span>
        </span>
        {r.location && <span className="block truncate text-sm text-muted">{r.location}</span>}
        {(r.startsAt || r.reservationNumber) && (
          <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-faint">
            {r.startsAt && (
              <span className="inline-flex items-center gap-1">
                <ClockIcon className="size-3.5" />
                {spanLabel(r.startsAt, r.endsAt)}
              </span>
            )}
            {r.reservationNumber && <span>Ref {r.reservationNumber}</span>}
          </span>
        )}
      </span>
    </Link>
  );
}

function TripCard({ trip }: { trip: TripDto }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-bg">
      <header className="border-b border-border px-4 py-3">
        <h2 className="truncate text-base font-semibold text-fg">{trip.title}</h2>
        <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted">
          <CalendarIcon className="size-4 opacity-70" />
          {spanLabel(trip.startsAt, trip.endsAt)}
        </p>
      </header>
      <div className="flex flex-col gap-0.5 p-1.5">
        {trip.reservations.map((r) => (
          <ReservationRow key={`${r.messageId}-${r.type}-${r.startsAt ?? ''}`} r={r} />
        ))}
      </div>
    </section>
  );
}

export function Trips() {
  const navigate = useNavigate();
  const [trips, setTrips] = useState<TripDto[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(false);
      setTrips(await api.trips());
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top sticky top-0 z-10 flex items-center gap-1 border-b border-border bg-bg/85 px-2 py-2 backdrop-blur">
        <button
          onClick={() => navigate(-1)}
          className="rounded-full p-2 text-fg active:bg-surface-2"
          aria-label="Back"
        >
          <BackIcon />
        </button>
        <h1 className="flex-1 truncate px-2 text-lg font-semibold">Trips</h1>
      </header>

      <main className="flex-1 overflow-y-auto no-scrollbar">
        {error && trips === null ? (
          <p className="px-4 py-8 text-center text-danger">Couldn’t load trips.</p>
        ) : trips === null ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : trips.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-24 text-center text-muted">
            <span className="flex size-14 items-center justify-center rounded-full bg-surface text-faint">
              <MapPinIcon className="size-7" />
            </span>
            <p className="font-medium text-fg">No trips yet</p>
            <p className="max-w-xs text-sm">
              Flight, hotel and event confirmations in your mail are gathered here as a travel
              timeline.
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
            {trips.map((t) => (
              <TripCard key={t.id} trip={t} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
