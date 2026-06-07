/**
 * Proposal renderer registry — the frontend scalability seam for the Action Center.
 *
 * The Action Center is type-agnostic: it lists `ProposalDto`s and renders each through
 * the view registered for its `type` here. Adding a new enricher/proposal kind (the
 * ICS-invite enricher, a `package_track` operational variant, invoice payment offers,
 * …) is a single new entry below + a backend approve-handler — no change to the hub,
 * the card, or the inline chip. Unknown types fall back to a generic view, so a new
 * backend proposal type renders sensibly even before its bespoke view ships.
 *
 * Views read the (untyped) `payload` defensively: it's produced by a deterministic
 * enricher, but treating it as `unknown` keeps a malformed/partial payload from
 * breaking the render.
 */
import type { ComponentType, SVGProps } from 'react';
import { BoltIcon, CalendarIcon, ClockIcon, MapPinIcon, PackageIcon } from '../../ui/icons';
import { fullDate } from '../../ui/format';

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

/** One detail line under a proposal's title (an icon + text). */
export interface ProposalDetail {
  Icon?: Icon;
  text: string;
}

/** How a proposal type renders + what its approve verb reads. */
export interface ProposalView {
  /** Leading icon on the card / chip. */
  Icon: Icon;
  /** Short kind label, e.g. "Add to calendar". */
  kind: string;
  /** Verb on the approve button, e.g. "Add". */
  approveLabel: string;
  /** Detail lines pulled from the payload (date, place, …). */
  details(payload: unknown): ProposalDetail[];
}

/** Safe string field read off an untyped payload object. */
function field(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** "start → end" (or just one side) for an ISO date pair, tolerating missing parts. */
function dateRange(start: string | null, end: string | null): string | null {
  const s = start ? fullDate(start) : '';
  const e = end ? fullDate(end) : '';
  if (s && e) return `${s} → ${e}`;
  return s || e || null;
}

/**
 * `calendar_event` — the VEVENT-shaped offer the `travel` enricher emits (and the
 * future ICS-invite enricher will reuse). Payload is a CalendarEventDraft:
 * { summary, start, end, location, description, source }.
 */
const calendarEvent: ProposalView = {
  Icon: CalendarIcon,
  kind: 'Add to calendar',
  approveLabel: 'Add',
  details(payload) {
    const out: ProposalDetail[] = [];
    const when = dateRange(field(payload, 'start'), field(payload, 'end'));
    if (when) out.push({ Icon: ClockIcon, text: when });
    const where = field(payload, 'location');
    if (where) out.push({ Icon: MapPinIcon, text: where });
    const desc = field(payload, 'description');
    if (desc) out.push({ text: desc });
    return out;
  },
};

/**
 * `package_track` — placeholder view for the deferred operational shipment-tracking
 * offer (the `package` enricher is search-only today). Registered now so the offer
 * renders the moment that enricher starts emitting proposals; payload is expected to
 * carry { carrier, trackingNumber, estimatedDelivery, trackingUrl }.
 */
const packageTrack: ProposalView = {
  Icon: PackageIcon,
  kind: 'Track package',
  approveLabel: 'Track',
  details(payload) {
    const out: ProposalDetail[] = [];
    const carrier = field(payload, 'carrier');
    const num = field(payload, 'trackingNumber');
    if (carrier || num)
      out.push({ Icon: PackageIcon, text: [carrier, num].filter(Boolean).join(' · ') });
    const eta = field(payload, 'estimatedDelivery');
    if (eta) out.push({ Icon: ClockIcon, text: fullDate(eta) });
    return out;
  },
};

/** Generic fallback for an unrecognised proposal type (forward-compatible). */
const fallback: ProposalView = {
  Icon: BoltIcon,
  kind: 'Suggested action',
  approveLabel: 'Approve',
  details: () => [],
};

const registry: Record<string, ProposalView> = {
  calendar_event: calendarEvent,
  package_track: packageTrack,
};

/** The view for a proposal type, falling back to the generic view when unknown. */
export function proposalView(type: string): ProposalView {
  return registry[type] ?? fallback;
}
