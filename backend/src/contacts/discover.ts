/**
 * CardDAV address-book discovery (ROADMAP §C, contacts Phase 1). Hand-rolled over
 * `fetch` + regex, matching the lean transport in `./carddav.ts` (no CardDAV
 * dependency). Walks the standard discovery chain seeded from the configured
 * `CARDDAV_URL`:
 *
 *   current-user-principal → addressbook-home-set → PROPFIND Depth:1 collections,
 *
 * keeping only collections whose `resourcetype` includes `addressbook`. Any failure
 * (network, non-CardDAV server, Radicale quirk) degrades to a single book equal to
 * the configured URL, so the pre-multi-book behaviour always still works.
 */
import { createLogger } from '../logger.js';
import type { Addressbook } from './addressbooks.js';

const log = createLogger('carddav-discover');

/** The CardDAV connection fields discovery needs (subset of the env config). */
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
  /<(?:[a-zA-Z0-9]+:)?addressbook-home-set[\s>][\s\S]*?<\/(?:[a-zA-Z0-9]+:)?addressbook-home-set>/;
const PRINCIPAL_RE =
  /<(?:[a-zA-Z0-9]+:)?current-user-principal[\s>][\s\S]*?<\/(?:[a-zA-Z0-9]+:)?current-user-principal>/;
/** A collection is an address book when its resourcetype carries the carddav element. */
const ADDRESSBOOK_TYPE_RE = /<(?:[a-zA-Z0-9]+:)?addressbook[\s/>]/;

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
<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <prop><current-user-principal/><C:addressbook-home-set/></prop>
</propfind>`;

const HOMESET_ONLY_BODY = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <prop><C:addressbook-home-set/></prop>
</propfind>`;

const COLLECTIONS_BODY = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:"><prop><resourcetype/><displayname/></prop></propfind>`;

/** Locate the addressbook-home-set: directly on the configured URL, else via principal. */
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
 * Parse a Depth:1 collections multistatus into address books, keeping only
 * collections whose `resourcetype` carries the carddav `addressbook` element. Pure
 * (no I/O) so it can be tested in isolation; `base` resolves relative hrefs.
 */
export function parseBooks(xml: string, base: string): Addressbook[] {
  const out: Addressbook[] = [];
  for (const block of xml.match(RESP_RE) ?? []) {
    if (!ADDRESSBOOK_TYPE_RE.test(block)) continue; // skip the home-set self-entry / non-books
    const rawHref = HREF_RE.exec(block)?.[1];
    if (!rawHref) continue;
    const href = resolve(base, decodeXml(rawHref));
    const dn = DISPLAYNAME_RE.exec(block)?.[1];
    const name = dn ? decodeXml(dn) : '';
    out.push({ href, displayName: name || lastSegment(href) });
  }
  return out;
}

/** List the address-book collections under the home-set. */
async function listBooks(cfg: DiscoverConfig, homeUrl: string): Promise<Addressbook[]> {
  const xml = await propfind(cfg, homeUrl, COLLECTIONS_BODY, '1');
  if (!xml) return [];
  return parseBooks(xml, homeUrl);
}

/**
 * Discover all address books for the configured account. Never throws — on any
 * failure it returns a single book equal to the configured URL (status-quo behaviour).
 */
export async function discoverAddressbooks(cfg: DiscoverConfig): Promise<Addressbook[]> {
  const fallback: Addressbook[] = [{ href: cfg.url, displayName: 'Contacts' }];
  const home = await findHomeSet(cfg);
  if (!home) return fallback;
  const books = await listBooks(cfg, home);
  return books.length > 0 ? books : fallback;
}
