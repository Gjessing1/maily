/**
 * Minimal Radicale CardDAV client. Hand-rolled over `fetch` — no
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
import type { ContactImportResult } from '@maily/shared';
import { getCardByKey, replaceContacts, type ParsedContact } from './store.js';
import type { ImportPlan } from './importPlan.js';
import { buildVCard, extractCards, mergeVCard, parseVCard, type EditableCard } from './vcard.js';
import { discoverAddressbooks } from './discover.js';
import { effectiveActive, effectiveDefault, getDiscovered, setDiscovered } from './addressbooks.js';

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

/**
 * Absolute, slash-terminated URL of the book a new card should be created in.
 *
 * Any **discovered** book is a valid target — "active" only governs which books feed
 * composer autocomplete, so a book excluded from search must still be writable.
 * An unknown href falls back to the configured default.
 */
function targetCollection(
  cfg: NonNullable<ReturnType<typeof env.carddav>>,
  addressbookHref: string | null,
): string {
  const known = getDiscovered().map((b) => b.href);
  const chosen =
    addressbookHref && known.includes(addressbookHref) ? addressbookHref : effectiveDefault();
  const abs = chosen ? resolveHref(cfg, chosen) : collectionUrl(cfg);
  return abs.endsWith('/') ? abs : `${abs}/`;
}

/** Require CardDAV to be configured, or throw a 503 the route turns into a response. */
function requireConfig(): NonNullable<ReturnType<typeof env.carddav>> {
  const cfg = env.carddav();
  if (!cfg) throw new CardDavError('CardDAV is not configured', 503);
  return cfg;
}

/**
 * PUT a brand-new `<uid>.vcf` into the resolved collection (no cache re-sync — the
 * caller decides when to sync, so bulk imports sync once rather than per card).
 */
async function putNewCard(
  cfg: NonNullable<ReturnType<typeof env.carddav>>,
  collection: string,
  card: EditableCard,
): Promise<string> {
  const uid = randomUUID();
  const url = new URL(`${uid}.vcf`, collection).toString();
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: authHeader(cfg),
      'Content-Type': 'text/vcard; charset=utf-8',
      'If-None-Match': '*', // refuse to clobber an existing resource
    },
    body: buildVCard(uid, card),
  });
  if (!res.ok) throw new CardDavError(`CardDAV PUT failed: ${res.status}`, 502);
  return uid;
}

/**
 * Create a new card in the chosen address book (or the configured default).
 * Generates the UID + a `<uid>.vcf` resource. Returns the UID.
 */
export async function createCard(
  addressbookHref: string | null,
  card: EditableCard,
): Promise<string> {
  const cfg = requireConfig();
  await ensureDiscovered(); // a cold registry would reject a valid (inactive) target
  const uid = await putNewCard(cfg, targetCollection(cfg, addressbookHref), card);
  await syncContacts();
  return uid;
}

/**
 * Carry out a duplicate-aware import plan (`importPlan.ts`): PUT each new card as a fresh
 * resource, and rewrite each matched existing card with its merged fields (If-Match
 * guarded, unmodelled properties preserved). A single failed write is counted as skipped,
 * not fatal. Syncs the cache once at the end rather than after every card.
 */
export async function importCards(
  addressbookHref: string | null,
  plan: ImportPlan,
): Promise<ContactImportResult> {
  const cfg = requireConfig();
  await ensureDiscovered();
  const collection = targetCollection(cfg, addressbookHref);
  const result: ContactImportResult = {
    imported: 0,
    merged: 0,
    unchanged: plan.unchanged,
    skipped: plan.skipped,
  };
  for (const card of plan.creates) {
    try {
      await putNewCard(cfg, collection, card);
      result.imported++;
    } catch (err) {
      log.warn('import: card PUT failed:', (err as Error).message);
      result.skipped++;
    }
  }
  for (const { target, card } of plan.merges) {
    const rec = getCardByKey(target.uid);
    try {
      if (!rec?.href) throw new Error(`card ${target.uid} not found`);
      await putUpdatedCard(cfg, rec.uid, rec.href, rec.etag, rec.raw, card);
      result.merged++;
    } catch (err) {
      log.warn('import: merge into existing card failed:', (err as Error).message);
      result.skipped++;
    }
  }
  if (result.imported > 0 || result.merged > 0) await syncContacts();
  return result;
}

/**
 * Update an existing card in place (same UID). `etag` guards against lost updates;
 * `raw` is the card's current vCard so the edit preserves properties maily doesn't
 * model (PHOTO, X-* extensions) rather than rebuilding the card from scratch.
 */
export async function updateCard(
  uid: string,
  href: string,
  etag: string | null,
  raw: string | null,
  card: EditableCard,
): Promise<void> {
  await putUpdatedCard(requireConfig(), uid, href, etag, raw, card);
  await syncContacts();
}

/** PUT an edited card over its resource (no cache sync — callers decide when). */
async function putUpdatedCard(
  cfg: NonNullable<ReturnType<typeof env.carddav>>,
  uid: string,
  href: string,
  etag: string | null,
  raw: string | null,
  card: EditableCard,
): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: authHeader(cfg),
    'Content-Type': 'text/vcard; charset=utf-8',
  };
  if (etag) headers['If-Match'] = etag;
  const res = await fetch(resolveHref(cfg, href), {
    method: 'PUT',
    headers,
    body: mergeVCard(uid, raw, card),
  });
  if (res.status === 412) throw new CardDavError('Card changed on server; reload and retry', 409);
  if (!res.ok) throw new CardDavError(`CardDAV PUT failed: ${res.status}`, 502);
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

/** REPORT one book's cards, parsed + tagged with the book's identity. Empty on failure. */
async function fetchBook(
  cfg: NonNullable<ReturnType<typeof env.carddav>>,
  book: { href: string; displayName: string },
): Promise<ParsedContact[]> {
  let res: Response;
  try {
    res = await fetch(resolveHref(cfg, book.href), {
      method: 'REPORT',
      headers: {
        Authorization: authHeader(cfg),
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: REPORT_BODY,
    });
  } catch (err) {
    log.warn(`CardDAV REPORT ${book.href} failed:`, (err as Error).message);
    return [];
  }
  if (!res.ok) {
    log.warn(`CardDAV REPORT ${book.href} returned ${res.status} ${res.statusText}`);
    return [];
  }
  const cards = extractCards(await res.text());
  // Attach each card's href/etag + the owning book so edits/deletes can address the
  // exact resource and the manager can filter/group by book.
  return cards.flatMap((c) =>
    parseVCard(c.vcard).map((p) => ({
      ...p,
      href: c.href,
      etag: c.etag,
      addressbookHref: book.href,
      addressbookName: book.displayName,
      raw: c.vcard,
    })),
  );
}

/** Ensure the discovered address-book set is populated (lazy, for the settings API). */
export async function ensureDiscovered(): Promise<void> {
  const cfg = env.carddav();
  if (!cfg || getDiscovered().length > 0) return;
  setDiscovered(await discoverAddressbooks(cfg));
}

/**
 * Discover the address books, then fetch + parse **every** book's cards and replace
 * the local contacts cache, tagging each row with its owning book. The cache mirrors
 * the whole server so the Contacts manager can show and group all books; the
 * compose/autocomplete path (`searchContacts`) narrows to the *active* books at query
 * time, so toggling a book active only affects what the composer suggests, not what
 * the manager can browse.
 *
 * Inactive books are fetched first and active books last, so on the rare email that
 * lives in two books the active card wins the dedup (`replaceContacts` keeps the last
 * write) — keeping the composer's active-only view correct.
 */
export async function syncContacts(): Promise<void> {
  const cfg = env.carddav();
  if (!cfg) return;

  const books = await discoverAddressbooks(cfg);
  setDiscovered(books);

  const active = new Set(effectiveActive());
  const ordered = [
    ...books.filter((b) => !active.has(b.href)),
    ...books.filter((b) => active.has(b.href)),
  ];

  const parsed: ParsedContact[] = [];
  for (const book of ordered) parsed.push(...(await fetchBook(cfg, book)));

  const count = replaceContacts(parsed);
  log.info(`synced ${count} contact address(es) from ${books.length} book(s)`);
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
