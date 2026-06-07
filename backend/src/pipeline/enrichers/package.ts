/**
 * `package` — deterministic shipment / parcel-tracking enricher (ROADMAP Phase 4).
 *
 * Extracts carrier + tracking number (and, where available, a tracking URL and an
 * estimated-delivery date) from shipping mail, by three complementary deterministic
 * routes:
 *   1. schema.org `ParcelDelivery` JSON-LD — the authoritative source where present
 *      (Amazon, large retailers embed it, same markup family as the `travel`
 *      enricher); it carries `trackingNumber`, `trackingUrl`, the `carrier`/`provider`
 *      Organization, and `expectedArrivalUntil`.
 *   2. Carrier-anchored regex over the body text — for the long tail of carriers that
 *      ship a plain-text/HTML "your parcel is on its way" mail with no microdata.
 *   3. Carrier tracking-URL extraction over the raw markup — pulls the number straight
 *      out of a `tracking.bring.com/tracking/…`, `postnord.…?id=…`, `helthjem.no/
 *      sporing/…` link. This is how the Norwegian carriers (Posten/Bring, PostNord,
 *      Helthjem) are covered: their domestic numbers have no stable printable format,
 *      but the mail always links to the carrier's own tracking page — anchoring on the
 *      carrier *domain* gives the number with zero false positives.
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
 * numbers and the like, so the unconditional patterns (UPS `1Z…`, the UPU/S10
 * international-postal code) are **check-digit-validated** (the digit check the ROADMAP
 * asks for) — a random `XX#########NO`-shaped or `1Z…`-shaped string that fails its
 * checksum is dropped. The ambiguous all-digit carriers (FedEx/USPS/DHL) only match
 * when that carrier's name also appears in the body; the Norwegian carriers come in via
 * their tracking-URL host, never a bare number.
 */
import type { Enricher, EnricherContext, EnricherResult } from '../types.js';
import { collectJsonLdNodes, isObject, str, typesOf, type JsonObject } from './jsonld.js';

/** A normalised shipment — flat, search-friendly, provider-agnostic. */
export interface PackageShipment {
  /** Carrier label, e.g. 'UPS', 'FedEx', 'PostNord', 'Posten/Bring', 'Helthjem'. */
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
  /** Check-digit validator; a match that fails it is discarded (false-positive guard). */
  validate?: (n: string) => boolean;
}

/**
 * UPU S10 check-digit validation — the 9th digit of the serial block is a check digit
 * over the preceding 8 (weights 8,6,4,2,3,5,9,7; remainder→check-digit per the UPU
 * rule). Filters the many `[A-Z]{2}\d{9}[A-Z]{2}`-shaped strings that aren't real
 * postal items.
 */
function validS10(code: string): boolean {
  const digits = code.slice(2, 11); // the 9 digits between the service/country letters
  if (digits.length !== 9) return false;
  const weights = [8, 6, 4, 2, 3, 5, 9, 7];
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(digits[i]) * weights[i]!;
  const r = sum % 11;
  const check = r === 0 ? 5 : r === 1 ? 0 : 11 - r;
  return check === Number(digits[8]);
}

/**
 * UPS 1Z check-digit validation. Letters map A→2 … I→0 … (`(code-'A'+2) % 10`); the
 * check digit is `10 - (oddSum + 2·evenSum) % 10` over the 15 chars after "1Z", with
 * the 16th char being the check digit itself.
 */
function validUps(code: string): boolean {
  const body = code.slice(2); // 16 chars after "1Z"
  if (body.length !== 16) return false;
  const val = (ch: string): number =>
    ch >= '0' && ch <= '9' ? Number(ch) : (ch.charCodeAt(0) - 65 + 2) % 10;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const v = val(body[i]!);
    sum += i % 2 === 0 ? v : v * 2; // i=0 is position 1 (odd) → ×1, i=1 → ×2, …
  }
  const mod = sum % 10;
  const check = mod === 0 ? 0 : 10 - mod;
  return check === Number(body[15]);
}

// Ordered most-distinctive first so unambiguous matches win the dedup.
const CARRIERS: CarrierPattern[] = [
  {
    carrier: 'UPS',
    re: /\b1Z[0-9A-Z]{16}\b/g,
    distinctive: true,
    validate: validUps,
    url: (n) => `https://www.ups.com/track?tracknum=${n}`,
  },
  {
    // UPU S10: 2 letters + 9 digits + 2-letter country code (Posten/Bring, PostNord,
    // Royal Mail, Deutsche Post, …). Distinctive + check-digit-validated, so it runs
    // unconditionally; the Nordic carriers' country suffix is re-attributed in `run`.
    carrier: 'Postal',
    re: /\b[A-Z]{2}\d{9}[A-Z]{2}\b/g,
    distinctive: true,
    validate: validS10,
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

/**
 * Carrier tracking-URL hosts (route 3). Anchored on the carrier's own domain, so a
 * number lifted from one of these links is trustworthy without a separate digit check.
 * `build` rewrites a captured number to the carrier's canonical tracking page; when
 * absent the matched URL itself is kept.
 */
interface UrlCarrier {
  carrier: string;
  host: RegExp;
  build?: (n: string) => string;
}

const URL_CARRIERS: UrlCarrier[] = [
  {
    carrier: 'Posten/Bring',
    host: /(?:tracking\.bring\.com|sporing\.(?:bring|posten)\.no|\b(?:bring|posten)\.no)/i,
    build: (n) => `https://tracking.bring.com/tracking/${n}`,
  },
  {
    carrier: 'PostNord',
    host: /postnord\.(?:com|no|se|dk)/i,
    build: (n) => `https://tracking.postnord.com/no/?id=${n}`,
  },
  { carrier: 'Helthjem', host: /helthjem\.no/i },
];

/** Any http(s) URL, stopping at whitespace / quote / angle-bracket boundaries. */
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/gi;

/**
 * The tracking token inside a carrier URL — a path segment after a tracking keyword
 * (`tracking/…`, `sporing/…`) or a query value (`?id=…`, `?shipmentId=…`). 8–40 chars
 * of `[A-Za-z0-9]` keeps order-number / utm noise out.
 */
const URL_TOKEN =
  /(?:tracking|sporing|trackingnumber|shipmentid|colli|kolli)[/=]([A-Za-z0-9]{8,40})|[?&](?:id|q|tn|trackingnumber|shipmentid)=([A-Za-z0-9]{8,40})/i;

/** Coarse gate marker so most mail skips the work entirely. */
const HINT =
  /parceldelivery|tracking ?number|track your|trackingnumber|sporing|sendingsnummer|kollinummer|colli|postnord|helthjem|tracking\.bring|sporing\.(?:bring|posten)|\b1Z[0-9A-Z]{16}\b|\b[A-Z]{2}\d{9}[A-Z]{2}\b/i;

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
      if (c.validate && !c.validate(n)) continue; // digit check
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

/**
 * Re-attribute a generic S10 `Postal` hit to the Nordic carrier named in the body, so
 * a Posten parcel reads "Posten/Bring" (with a tracking link) rather than "Postal".
 * Returns null when no Nordic carrier is mentioned (keeps the generic label).
 */
function nordicPostal(text: string): { carrier: string; url?: (n: string) => string } | null {
  const t = text.toLowerCase();
  if (/postnord/.test(t))
    return { carrier: 'PostNord', url: (n) => `https://tracking.postnord.com/no/?id=${n}` };
  if (/\bbring\b|posten/.test(t))
    return { carrier: 'Posten/Bring', url: (n) => `https://tracking.bring.com/tracking/${n}` };
  if (/helthjem/.test(t)) return { carrier: 'Helthjem' };
  return null;
}

/** Decode the `&amp;` that HTML hrefs carry, so query-string params parse cleanly. */
function decodeUrl(url: string): string {
  return url.replace(/&amp;/gi, '&');
}

/**
 * Route 3 — pull tracking numbers out of carrier tracking-page links in the raw markup.
 * Anchored on the carrier domain, so it never fires on a non-carrier email.
 */
function fromTrackingUrls(raw: string): PackageShipment[] {
  const out: PackageShipment[] = [];
  for (const m of raw.matchAll(URL_RE)) {
    const url = decodeUrl(m[0]);
    for (const c of URL_CARRIERS) {
      if (!c.host.test(url)) continue;
      const tok = url.match(URL_TOKEN);
      const number = tok?.[1] ?? tok?.[2];
      if (!number) break; // carrier link without a tracking token (e.g. homepage) → skip
      out.push({
        carrier: c.carrier,
        trackingNumber: number,
        trackingUrl: c.build ? c.build(number) : url,
        estimatedDelivery: null,
        source: 'regex',
      });
      break; // first matching carrier host wins for this URL
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
  version: 2,
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
    if (text) {
      const regexShips = fromRegex(text);
      const nordic = nordicPostal(text);
      if (nordic) {
        for (const s of regexShips) {
          if (s.carrier !== 'Postal') continue;
          s.carrier = nordic.carrier;
          if (nordic.url) s.trackingUrl = nordic.url(s.trackingNumber);
        }
      }
      shipments.push(...regexShips);
    }

    // 3. Carrier tracking-URL extraction over the raw markup (Norwegian carriers et al).
    const raw = `${bodyHtml ?? ''}\n${bodyText ?? ''}`;
    if (raw.trim()) shipments.push(...fromTrackingUrls(raw));

    return { result: { shipments: dedupe(shipments) } };
  },
};
