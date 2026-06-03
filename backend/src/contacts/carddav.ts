/**
 * Minimal Radicale CardDAV client (ROADMAP §3.7.D/B). Hand-rolled over `fetch` — no
 * CardDAV/vCard dependency, in keeping with the project's lean stack. It issues a
 * single `addressbook-query` REPORT for every card's vCard data, parses out names
 * and emails, and replaces the local contacts cache. It also writes back: create
 * (PUT a new `<uid>.vcf`), update (PUT in place, guarded by If-Match), and delete.
 *
 * Scope is deliberately narrow: one collection, the vCard fields we use
 * (FN / N / EMAIL / UID). We do not implement sync-tokens or etag deltas — the
 * addressbook is small and a full refresh on an interval (and after each write) is
 * simpler and robust. Radicale stays authoritative: every write re-syncs the cache.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger.js';
import { env } from '../env.js';
import { replaceContacts, type ParsedContact } from './store.js';

const log = createLogger('carddav');

/** A card as seen in the REPORT: its resource path, etag, and raw vCard text. */
export interface RawCard {
  href: string;
  etag: string | null;
  vcard: string;
}

/** Thrown for CardDAV write failures so routes can map them to HTTP status. */
export class CardDavError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const REPORT_BODY = `<?xml version="1.0" encoding="utf-8"?>
<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:prop>
    <D:getetag/>
    <C:address-data/>
  </D:prop>
</C:addressbook-query>`;

/** Decode the handful of XML entities that can appear inside address-data text. */
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#13;/g, '\r')
    .replace(/&#10;/g, '\n')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const HREF_RE = /<(?:[a-zA-Z0-9]+:)?href[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?href>/;
const ETAG_RE = /<(?:[a-zA-Z0-9]+:)?getetag[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?getetag>/;
const ADDR_RE = /<(?:[a-zA-Z0-9]+:)?address-data[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?address-data>/;
const RESP_RE = /<(?:[a-zA-Z0-9]+:)?response[\s>][\s\S]*?<\/(?:[a-zA-Z0-9]+:)?response>/g;

/**
 * Pull every card (`href` + `getetag` + `address-data`) out of a multistatus body,
 * one per `<response>`. The href/etag identify the card so it can later be updated
 * or deleted; the vCard text carries the name/emails.
 */
export function extractCards(xml: string): RawCard[] {
  const out: RawCard[] = [];
  for (const block of xml.match(RESP_RE) ?? []) {
    const href = HREF_RE.exec(block)?.[1];
    const vcard = ADDR_RE.exec(block)?.[1];
    if (!href || !vcard) continue; // collection self-entry / non-card responses
    const etag = ETAG_RE.exec(block)?.[1];
    out.push({
      href: decodeXml(href).trim(),
      etag: etag ? decodeXml(etag).trim() : null,
      vcard: decodeXml(vcard),
    });
  }
  return out;
}

/** Unfold RFC 6350 line folding: continuation lines begin with a space or tab. */
function unfold(vcard: string): string[] {
  return vcard
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Strip a vCard value of the common backslash escapes (\, \n \\). */
function unescapeValue(v: string): string {
  return v
    .replace(/\\n/gi, ' ')
    .replace(/\\([,;\\])/g, '$1')
    .trim();
}

/** Parse one vCard's lines into a name + its email addresses. */
export function parseVCard(vcard: string): ParsedContact[] {
  const lines = unfold(vcard);
  let fn: string | null = null;
  let structuredName: string | null = null;
  let uid: string | null = null;
  const emails: string[] = [];

  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const rawKey = line.slice(0, colon);
    const value = line.slice(colon + 1);
    // Drop any group prefix (`item1.EMAIL`) and parameters (`EMAIL;TYPE=work`).
    const prop = rawKey.split(';')[0]!.split('.').pop()!.toUpperCase();

    if (prop === 'FN') fn = unescapeValue(value);
    else if (prop === 'UID') uid = unescapeValue(value);
    else if (prop === 'EMAIL') {
      const addr = unescapeValue(value);
      if (addr) emails.push(addr);
    } else if (prop === 'N' && !structuredName) {
      // N = Family;Given;Additional;Prefix;Suffix → "Given Family".
      const [family = '', given = ''] = value.split(';').map(unescapeValue);
      structuredName = `${given} ${family}`.trim() || null;
    }
  }

  const name = fn ?? structuredName;
  return emails.map((email) => ({ email, name, vcardUid: uid }));
}

/** Basic-auth header for the configured CardDAV account. */
function authHeader(cfg: NonNullable<ReturnType<typeof env.carddav>>): string {
  return `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64')}`;
}

/** Escape a vCard text value (RFC 6350 §3.4): backslash, comma, semicolon, newline. */
function escapeValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

/**
 * Build a vCard 3.0 document for a card. 3.0 is the most broadly compatible with
 * Radicale and other clients. `N` is derived best-effort from the name (last token
 * = family) since 3.0 nominally requires it; `FN` carries the canonical display name.
 */
export function buildVCard(uid: string, name: string | null, emails: string[]): string {
  const fn = (name ?? '').trim();
  const parts = fn ? fn.split(/\s+/) : [];
  const family = parts.length > 1 ? parts[parts.length - 1]! : '';
  const given = parts.length > 1 ? parts.slice(0, -1).join(' ') : fn;
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `UID:${escapeValue(uid)}`,
    `FN:${escapeValue(fn)}`,
    `N:${escapeValue(family)};${escapeValue(given)};;;`,
    ...emails.map((e) => `EMAIL;TYPE=INTERNET:${escapeValue(e.trim())}`),
    'END:VCARD',
  ];
  return lines.join('\r\n') + '\r\n';
}

/** Resolve a (possibly relative) card href against the configured collection URL. */
function resolveHref(cfg: NonNullable<ReturnType<typeof env.carddav>>, href: string): string {
  return new URL(href, cfg.url).toString();
}

/** Collection URL guaranteed to end in `/` so new card paths append cleanly. */
function collectionUrl(cfg: NonNullable<ReturnType<typeof env.carddav>>): string {
  return cfg.url.endsWith('/') ? cfg.url : `${cfg.url}/`;
}

/** Require CardDAV to be configured, or throw a 503 the route turns into a response. */
function requireConfig(): NonNullable<ReturnType<typeof env.carddav>> {
  const cfg = env.carddav();
  if (!cfg) throw new CardDavError('CardDAV is not configured', 503);
  return cfg;
}

/** Create a new card. Generates the UID + a `<uid>.vcf` resource. Returns the UID. */
export async function createCard(name: string | null, emails: string[]): Promise<string> {
  const cfg = requireConfig();
  const uid = randomUUID();
  const url = new URL(`${uid}.vcf`, collectionUrl(cfg)).toString();
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: authHeader(cfg),
      'Content-Type': 'text/vcard; charset=utf-8',
      'If-None-Match': '*', // refuse to clobber an existing resource
    },
    body: buildVCard(uid, name, emails),
  });
  if (!res.ok) throw new CardDavError(`CardDAV PUT failed: ${res.status}`, 502);
  await syncContacts();
  return uid;
}

/** Update an existing card in place (same UID). `etag` guards against lost updates. */
export async function updateCard(
  uid: string,
  href: string,
  etag: string | null,
  name: string | null,
  emails: string[],
): Promise<void> {
  const cfg = requireConfig();
  const headers: Record<string, string> = {
    Authorization: authHeader(cfg),
    'Content-Type': 'text/vcard; charset=utf-8',
  };
  if (etag) headers['If-Match'] = etag;
  const res = await fetch(resolveHref(cfg, href), {
    method: 'PUT',
    headers,
    body: buildVCard(uid, name, emails),
  });
  if (res.status === 412) throw new CardDavError('Card changed on server; reload and retry', 409);
  if (!res.ok) throw new CardDavError(`CardDAV PUT failed: ${res.status}`, 502);
  await syncContacts();
}

/** Delete a card by its resource path. */
export async function deleteCard(href: string): Promise<void> {
  const cfg = requireConfig();
  const res = await fetch(resolveHref(cfg, href), {
    method: 'DELETE',
    headers: { Authorization: authHeader(cfg) },
  });
  // 404 = already gone; treat as success so the UI converges.
  if (!res.ok && res.status !== 404)
    throw new CardDavError(`CardDAV DELETE failed: ${res.status}`, 502);
  await syncContacts();
}

/** Fetch + parse every card, then replace the local contacts cache. */
export async function syncContacts(): Promise<void> {
  const cfg = env.carddav();
  if (!cfg) return;

  let res: Response;
  try {
    res = await fetch(cfg.url, {
      method: 'REPORT',
      headers: {
        Authorization: authHeader(cfg),
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: REPORT_BODY,
    });
  } catch (err) {
    log.warn('CardDAV request failed:', (err as Error).message);
    return;
  }

  if (!res.ok) {
    log.warn(`CardDAV REPORT returned ${res.status} ${res.statusText}`);
    return;
  }

  const xml = await res.text();
  const cards = extractCards(xml);
  // Attach each card's href/etag to its parsed address rows so edits/deletes can
  // address the exact resource later.
  const parsed: ParsedContact[] = cards.flatMap((c) =>
    parseVCard(c.vcard).map((p) => ({ ...p, href: c.href, etag: c.etag })),
  );
  const count = replaceContacts(parsed);
  log.info(`synced ${count} contact address(es) from ${cards.length} card(s)`);
}

/** Start the contacts sync loop: once on boot, then on the configured interval. */
export function startContactsSync(): void {
  const cfg = env.carddav();
  if (!cfg) {
    log.info('CardDAV not configured (CARDDAV_URL/USER/PASSWORD) — contacts sync disabled');
    return;
  }
  void syncContacts();
  const timer = setInterval(() => void syncContacts(), cfg.refreshMs);
  if (typeof timer.unref === 'function') timer.unref();
}
