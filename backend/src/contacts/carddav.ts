/**
 * Minimal Radicale CardDAV client (ROADMAP §3.7.D). Hand-rolled over `fetch` — no
 * CardDAV/vCard dependency, in keeping with the project's lean stack. It issues a
 * single `addressbook-query` REPORT for every card's vCard data, parses out names
 * and emails, and replaces the local contacts cache.
 *
 * Scope is deliberately narrow: read-only, one collection, the vCard fields we use
 * (FN / N / EMAIL / UID). We do not implement sync-tokens or etag deltas — the
 * addressbook is small and a full refresh on an interval is simpler and robust.
 */
import { createLogger } from '../logger.js';
import { env } from '../env.js';
import { replaceContacts, type ParsedContact } from './store.js';

const log = createLogger('carddav');

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

/** Pull every `<address-data>` payload (the raw vCards) out of a multistatus body. */
export function extractVCards(xml: string): string[] {
  const re = /<(?:[a-zA-Z0-9]+:)?address-data[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?address-data>/g;
  const out: string[] = [];
  for (const m of xml.matchAll(re)) {
    if (m[1]) out.push(decodeXml(m[1]));
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

/** Fetch + parse every card, then replace the local contacts cache. */
export async function syncContacts(): Promise<void> {
  const cfg = env.carddav();
  if (!cfg) return;

  const auth = Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64');
  let res: Response;
  try {
    res = await fetch(cfg.url, {
      method: 'REPORT',
      headers: {
        Authorization: `Basic ${auth}`,
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
  const vcards = extractVCards(xml);
  const parsed: ParsedContact[] = vcards.flatMap(parseVCard);
  const count = replaceContacts(parsed);
  log.info(`synced ${count} contact address(es) from ${vcards.length} card(s)`);
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
