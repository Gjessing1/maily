/**
 * CalDAV calendar discovery — the calendar twin of `../contacts/discover.ts`.
 * Hand-rolled over `fetch` + regex (no CalDAV dependency), walking the standard
 * discovery chain seeded from the configured `CALDAV_URL`:
 *
 *   current-user-principal → calendar-home-set → PROPFIND Depth:1 collections,
 *
 * keeping only collections whose `resourcetype` includes `calendar` and which
 * accept VEVENTs (Radicale task lists advertise a VTODO-only component set —
 * useless as an event target, so they're skipped). Any failure (network,
 * non-CalDAV server, `CALDAV_URL` pointing straight at one collection) degrades
 * to a single calendar equal to the configured URL, preserving the original
 * single-collection behaviour.
 */
import { createLogger } from '../logger.js';
import type { Calendar } from './calendars.js';

const log = createLogger('caldav-discover');

/** The CalDAV connection fields discovery needs (subset of the env config). */
export interface DiscoverConfig {
  url: string;
  user: string;
  password: string;
}

function authHeader(cfg: DiscoverConfig): string {
  return `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64')}`;
}

/** Decode the handful of XML entities that appear in href/displayname text. */
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

const RESP_RE = /<(?:[a-zA-Z0-9]+:)?response[\s>][\s\S]*?<\/(?:[a-zA-Z0-9]+:)?response>/g;
const HREF_RE = /<(?:[a-zA-Z0-9]+:)?href[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?href>/;
const DISPLAYNAME_RE =
  /<(?:[a-zA-Z0-9]+:)?displayname[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?displayname>/;
const HOMESET_RE =
  /<(?:[a-zA-Z0-9]+:)?calendar-home-set[\s>][\s\S]*?<\/(?:[a-zA-Z0-9]+:)?calendar-home-set>/;
const PRINCIPAL_RE =
  /<(?:[a-zA-Z0-9]+:)?current-user-principal[\s>][\s\S]*?<\/(?:[a-zA-Z0-9]+:)?current-user-principal>/;
/**
 * A collection is a calendar when its resourcetype carries the caldav element.
 * The name boundary `[\s/>]` keeps `calendar-home-set` / `supported-calendar-
 * component-set` from matching (their names continue with `-`).
 */
const CALENDAR_TYPE_RE = /<(?:[a-zA-Z0-9]+:)?calendar[\s/>]/;
/** The advertised component set, when present (Radicale always reports one). */
const COMPSET_RE =
  /<(?:[a-zA-Z0-9]+:)?supported-calendar-component-set[\s>][\s\S]*?<\/(?:[a-zA-Z0-9]+:)?supported-calendar-component-set>/;
const VEVENT_COMP_RE = /<(?:[a-zA-Z0-9]+:)?comp\s[^>]*name="VEVENT"/;

/** Resolve a (possibly relative) href against a base URL into an absolute URL. */
function resolve(base: string, href: string): string {
  return new URL(href, base).toString();
}

/** Last non-empty path segment of an href, used as a display-name fallback. */
function lastSegment(href: string): string {
  const parts = href.replace(/\/+$/, '').split('/');
  return decodeURIComponent(parts[parts.length - 1] || href);
}

/** The first <href> inside the first match of `sectionRe`, resolved against `base`. */
function hrefInside(xml: string, sectionRe: RegExp, base: string): string | null {
  const section = sectionRe.exec(xml)?.[0];
  if (!section) return null;
  const href = HREF_RE.exec(section)?.[1];
  return href ? resolve(base, decodeXml(href)) : null;
}

async function propfind(
  cfg: DiscoverConfig,
  url: string,
  body: string,
  depth: '0' | '1',
): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method: 'PROPFIND',
      headers: {
        Authorization: authHeader(cfg),
        Depth: depth,
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body,
    });
    if (!res.ok) {
      log.warn(`PROPFIND ${url} -> ${res.status} ${res.statusText}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    log.warn(`PROPFIND ${url} failed: ${(err as Error).message}`);
    return null;
  }
}

const HOMESET_BODY = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <prop><current-user-principal/><C:calendar-home-set/></prop>
</propfind>`;

const HOMESET_ONLY_BODY = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <prop><C:calendar-home-set/></prop>
</propfind>`;

const COLLECTIONS_BODY = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <prop><resourcetype/><displayname/><C:supported-calendar-component-set/></prop>
</propfind>`;

/** Locate the calendar-home-set: directly on the configured URL, else via principal. */
async function findHomeSet(cfg: DiscoverConfig): Promise<string | null> {
  const xml = await propfind(cfg, cfg.url, HOMESET_BODY, '0');
  if (!xml) return null;

  const direct = hrefInside(xml, HOMESET_RE, cfg.url);
  if (direct) return direct;

  const principal = hrefInside(xml, PRINCIPAL_RE, cfg.url);
  if (!principal) return null;

  const pxml = await propfind(cfg, principal, HOMESET_ONLY_BODY, '0');
  if (!pxml) return null;
  return hrefInside(pxml, HOMESET_RE, principal);
}

/**
 * Parse a Depth:1 collections multistatus into calendars, keeping only `calendar`
 * collections that accept VEVENTs (no advertised component set counts as "accepts
 * everything"). Pure (no I/O) so it can be tested in isolation; `base` resolves
 * relative hrefs.
 */
export function parseCalendars(xml: string, base: string): Calendar[] {
  const out: Calendar[] = [];
  for (const block of xml.match(RESP_RE) ?? []) {
    if (!CALENDAR_TYPE_RE.test(block)) continue; // home-set self-entry / non-calendars
    const compset = COMPSET_RE.exec(block)?.[0];
    if (compset && !VEVENT_COMP_RE.test(compset)) continue; // VTODO-only task list
    const rawHref = HREF_RE.exec(block)?.[1];
    if (!rawHref) continue;
    const href = resolve(base, decodeXml(rawHref));
    const dn = DISPLAYNAME_RE.exec(block)?.[1];
    const name = dn ? decodeXml(dn) : '';
    out.push({ href, displayName: name || lastSegment(href) });
  }
  return out;
}

/** List the calendar collections under the home-set. */
async function listCalendars(cfg: DiscoverConfig, homeUrl: string): Promise<Calendar[]> {
  const xml = await propfind(cfg, homeUrl, COLLECTIONS_BODY, '1');
  if (!xml) return [];
  return parseCalendars(xml, homeUrl);
}

/**
 * Discover all event calendars for the configured account. Never throws — on any
 * failure it returns a single calendar equal to the configured URL (the original
 * single-collection behaviour).
 */
export async function discoverCalendars(cfg: DiscoverConfig): Promise<Calendar[]> {
  const fallback: Calendar[] = [{ href: cfg.url, displayName: 'Calendar' }];
  const home = await findHomeSet(cfg);
  if (!home) return fallback;
  const calendars = await listCalendars(cfg, home);
  return calendars.length > 0 ? calendars : fallback;
}
