/**
 * `package` — deterministic shipment / parcel-tracking enricher (ROADMAP Phase 4).
 *
 * Extracts carrier + tracking number (and, where available, a tracking URL and an
 * estimated-delivery date) from shipping mail, by two complementary deterministic
 * routes:
 *   1. schema.org `ParcelDelivery` JSON-LD — the authoritative source where present
 *      (Amazon, large retailers embed it, same markup family as the `travel`
 *      enricher); it carries `trackingNumber`, `trackingUrl`, the `carrier`/`provider`
 *      Organization, and `expectedArrivalUntil`.
 *   2. Carrier-anchored regex over the body text — for the long tail of carriers that
 *      ship a plain-text/HTML "your parcel is on its way" mail with no microdata.
 *
 * Classification: `search` (passive-by-default, ARCHITECTURE §14 / the ROADMAP
 * anti-chore guardrail). The extracted shipments are *facts* that feed the search
 * index and the future Purchase Object / Evidence Locker timeline — surfaced
 * in-message ("where's my parcel"), NOT a notification stream. Because it is
 * `search`-kind it runs on ALL tiers (old shipping mail stays searchable) and emits
 * NO proposals: delivery reminders / delayed / delivered *alerts* are a separate
 * **operational**, opt-in, Tier-0-gated enricher (deferred), so a years-deep backfill
 * can never fire a stale "your package shipped" push.
 *
 * False-positive discipline: tracking numbers overlap with order numbers, phone
 * numbers and the like, so only **distinctive** formats run unconditionally (UPS
 * `1Z…`, the UPU/S10 international-postal code); the ambiguous all-digit carriers
 * (FedEx/USPS/DHL) only match when that carrier's name also appears in the body.
 */
import type { Enricher, EnricherContext, EnricherResult } from '../types.js';
import { collectJsonLdNodes, isObject, str, typesOf, type JsonObject } from './jsonld.js';

/** A normalised shipment — flat, search-friendly, provider-agnostic. */
export interface PackageShipment {
  /** Carrier label, e.g. 'UPS', 'FedEx', 'USPS', 'DHL', 'Postal'. */
  carrier: string;
  /** The tracking / reference number as printed (original case preserved). */
  trackingNumber: string;
  /** Carrier tracking-page URL, when known or supplied by JSON-LD. */
  trackingUrl: string | null;
  /** ISO 8601 estimated delivery (`expectedArrivalUntil`), when supplied. */
  estimatedDelivery: string | null;
  /** Where this came from — provenance for the Purchase Object / debugging. */
  source: 'jsonld' | 'regex';
}

/** A carrier pattern descriptor for the regex route. */
interface CarrierPattern {
  carrier: string;
  /** Distinctive tracking-number regex (global, so all matches are collected). */
  re: RegExp;
  /**
   * When true the pattern is distinctive enough to run unconditionally; when false it
   * only runs if `keyword` appears in the body (guards ambiguous all-digit formats).
   */
  distinctive: boolean;
  /** Body keyword that must be present to trust a non-distinctive pattern. */
  keyword?: RegExp;
  /** Build the carrier's tracking URL for a number, if it has a stable one. */
  url?: (n: string) => string;
}

// Ordered most-distinctive first so unambiguous matches win the dedup.
const CARRIERS: CarrierPattern[] = [
  {
    carrier: 'UPS',
    re: /\b1Z[0-9A-Z]{16}\b/g,
    distinctive: true,
    url: (n) => `https://www.ups.com/track?tracknum=${n}`,
  },
  {
    // UPU S10: 2 letters + 9 digits + 2-letter country code (Posten/Bring, PostNord,
    // Royal Mail, Deutsche Post, …). Distinctive enough to run unconditionally.
    carrier: 'Postal',
    re: /\b[A-Z]{2}\d{9}[A-Z]{2}\b/g,
    distinctive: true,
  },
  {
    carrier: 'FedEx',
    re: /\b(?:\d{12}|\d{15}|\d{20})\b/g,
    distinctive: false,
    keyword: /fedex/i,
    url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`,
  },
  {
    carrier: 'USPS',
    re: /\b9\d{15,21}\b/g,
    distinctive: false,
    keyword: /usps|united states postal/i,
    url: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
  },
  {
    carrier: 'DHL',
    re: /\b\d{10,11}\b/g,
    distinctive: false,
    keyword: /dhl/i,
    url: (n) => `https://www.dhl.com/en/express/tracking.html?AWB=${n}`,
  },
];

/** Coarse gate marker so most mail skips the work entirely. */
const HINT =
  /parceldelivery|tracking number|track your|trackingnumber|\b1Z[0-9A-Z]{16}\b|\b[A-Z]{2}\d{9}[A-Z]{2}\b/i;

/** Very light HTML→text strip for the regex route (markup-free, lowercase-safe). */
function stripHtml(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pull the carrier/provider Organization name from a ParcelDelivery node. */
function carrierName(node: JsonObject): string | null {
  for (const key of ['carrier', 'provider']) {
    const v = node[key];
    if (isObject(v)) {
      const name = str(v, 'name');
      if (name) return name;
    } else if (typeof v === 'string' && v.trim()) {
      return v.trim();
    }
  }
  return null;
}

/** Map one JSON-LD node to a shipment, or null if it isn't a ParcelDelivery. */
function fromParcelDelivery(node: JsonObject): PackageShipment | null {
  if (!typesOf(node).includes('ParcelDelivery')) return null;
  const trackingNumber = str(node, 'trackingNumber');
  if (!trackingNumber) return null;
  return {
    carrier: carrierName(node) ?? 'Unknown',
    trackingNumber,
    trackingUrl: str(node, 'trackingUrl'),
    estimatedDelivery: str(node, 'expectedArrivalUntil') ?? str(node, 'expectedArrivalFrom'),
    source: 'jsonld',
  };
}

/**
 * ParcelDelivery can sit directly in a `<script>` block, or nested as an Order's
 * `orderDelivery`. Collect both shapes.
 */
function parcelNodes(nodes: JsonObject[]): JsonObject[] {
  const out: JsonObject[] = [];
  for (const node of nodes) {
    out.push(node);
    const delivery = node['orderDelivery'];
    if (isObject(delivery)) out.push(delivery);
  }
  return out;
}

/** Apply every eligible carrier regex to the plain-text body. */
function fromRegex(text: string): PackageShipment[] {
  const out: PackageShipment[] = [];
  for (const c of CARRIERS) {
    if (!c.distinctive && !(c.keyword && c.keyword.test(text))) continue;
    for (const m of text.matchAll(c.re)) {
      const n = m[0];
      out.push({
        carrier: c.carrier,
        trackingNumber: n,
        trackingUrl: c.url ? c.url(n) : null,
        estimatedDelivery: null,
        source: 'regex',
      });
    }
  }
  return out;
}

/** Dedup by tracking number (case-insensitive); a JSON-LD hit wins over a regex one. */
function dedupe(shipments: PackageShipment[]): PackageShipment[] {
  const byNumber = new Map<string, PackageShipment>();
  for (const s of shipments) {
    const key = s.trackingNumber.toLowerCase();
    const existing = byNumber.get(key);
    if (!existing || (existing.source === 'regex' && s.source === 'jsonld')) {
      byNumber.set(key, s);
    }
  }
  return [...byNumber.values()];
}

export const packageEnricher: Enricher = {
  name: 'package',
  version: 1,
  kind: 'search',
  // Cheap gate: skip mail with no tracking-ish marker in either body part.
  applies(message) {
    return Boolean(
      (message.bodyText && HINT.test(message.bodyText)) ||
      (message.bodyHtml && HINT.test(message.bodyHtml)),
    );
  },
  run(ctx: EnricherContext): EnricherResult {
    const { bodyText, bodyHtml } = ctx.message;

    const shipments: PackageShipment[] = [];

    // 1. Authoritative JSON-LD ParcelDelivery (HTML bodies only).
    if (bodyHtml) {
      for (const node of parcelNodes(collectJsonLdNodes(bodyHtml))) {
        const s = fromParcelDelivery(node);
        if (s) shipments.push(s);
      }
    }

    // 2. Carrier-anchored regex over the plain-text body (or stripped HTML fallback).
    const text = bodyText?.trim() || (bodyHtml ? stripHtml(bodyHtml) : '');
    if (text) shipments.push(...fromRegex(text));

    return { result: { shipments: dedupe(shipments) } };
  },
};
