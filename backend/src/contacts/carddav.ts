/**
 * Minimal Radicale CardDAV client (ROADMAP §3.7.D/B). Hand-rolled over `fetch` — no
 * CardDAV/vCard dependency, in keeping with the project's lean stack. It issues a
 * single `addressbook-query` REPORT for every card's vCard data, parses out names
 * and emails (via the pure codec in `./vcard.js`), and replaces the local contacts
 * cache. It also writes back: create (PUT a new `<uid>.vcf`), update (PUT in place,
 * guarded by If-Match), and delete.
 *
 * This module is the transport + orchestration layer; the vCard/multistatus
 * parsing and serialisation live in `./vcard.js`. We do not implement sync-tokens
 * or etag deltas — the addressbook is small and a full refresh on an interval (and
 * after each write) is simpler and robust. Radicale stays authoritative: every
 * write re-syncs the cache.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger.js';
import { env } from '../env.js';
import { replaceContacts, type ParsedContact } from './store.js';
import { buildVCard, extractCards, parseVCard } from './vcard.js';

const log = createLogger('carddav');

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

/** Basic-auth header for the configured CardDAV account. */
function authHeader(cfg: NonNullable<ReturnType<typeof env.carddav>>): string {
  return `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64')}`;
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
