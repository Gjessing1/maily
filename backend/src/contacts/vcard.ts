/**
 * Pure vCard / CardDAV-multistatus codec (no I/O). Split out of `carddav.ts` so the
 * parsing/serialisation can be reasoned about and tested in isolation from the HTTP
 * transport. Scope is deliberately narrow — one collection, the fields we use
 * (FN / N / EMAIL / UID) — matching the lean stack (no CardDAV/vCard dependency).
 *
 * Two directions:
 *   - read:  multistatus XML → `RawCard[]` (`extractCards`), vCard text → `ParsedContact[]`
 *            (`parseVCard`).
 *   - write: a card's name + emails → a vCard 3.0 document (`buildVCard`).
 */
import type { ParsedContact } from './store.js';

/** A card as seen in the REPORT: its resource path, etag, and raw vCard text. */
export interface RawCard {
  href: string;
  etag: string | null;
  vcard: string;
}

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
