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
  // A card with no EMAIL property still belongs in the address book; emit one
  // email-less row so it's cached and surfaced in the manager (it just won't feed
  // compose autocomplete). The card key (UID/href) keeps it dedupable downstream.
  if (emails.length === 0) return [{ email: null, name, vcardUid: uid }];
  return emails.map((email) => ({ email, name, vcardUid: uid }));
}

/** Escape a vCard text value (RFC 6350 §3.4): backslash, comma, semicolon, newline. */
function escapeValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

// ── Rich fields (contacts Phase 2) ──────────────────────────────────────────────
// We parse a card's full detail for display and round-trip edits while keeping
// Radicale authoritative: edits rewrite only the properties maily models and leave
// everything else (PHOTO, X-* extensions, REV, …) untouched — see `mergeVCard`.

/** A value carrying an optional label, e.g. a phone or URL tagged Home/Work/Cell. */
export interface TypedValue {
  type: string | null;
  value: string;
}

/** A structured postal address (vCard `ADR`); the PO-box/extended slots are unused. */
export interface VCardAddress {
  type: string | null;
  street: string;
  locality: string;
  region: string;
  postalCode: string;
  country: string;
}

/** The editable subset of a card maily models — the fields a build/merge rewrites. */
export interface EditableCard {
  name: string | null;
  nickname: string | null;
  org: string | null;
  title: string | null;
  emails: string[];
  phones: TypedValue[];
  urls: TypedValue[];
  addresses: VCardAddress[];
  birthday: string | null;
  note: string | null;
  categories: string[];
  /**
   * Profile photo to write: a `data:` URI / `https:` URL (set), `null` (remove), or
   * `undefined` (leave the card's existing PHOTO untouched). Unlike the other fields PHOTO
   * is tri-state because it is large/binary — a blank edit must not wipe an existing photo.
   */
  photo?: string | null;
}

/** A parsed card: the editable fields, plus read-only display extras (UID, photo). */
export interface CardDetail extends EditableCard {
  uid: string | null;
  /** A renderable image source for the avatar (data: URI or external URL), if any. */
  photo: string | null;
}

/** One physical vCard line, split into property, parameters, and raw value. */
interface VLine {
  prop: string;
  params: Record<string, string>;
  /** Lowercased TYPE values (e.g. `['home','voice']`), comma- or repeat-split. */
  types: string[];
  value: string;
}

/** Unescape `\,` `\;` `\\` but keep newlines as real line breaks (for NOTE/ADR). */
function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, '\n')
    .replace(/\\([,;\\])/g, '$1')
    .trim();
}

/** Tokenise one unfolded line into property + params + value. */
function parseLine(line: string): VLine | null {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segs = head.split(';');
  const prop = segs[0]!.split('.').pop()!.toUpperCase();
  const params: Record<string, string> = {};
  const types: string[] = [];
  for (const seg of segs.slice(1)) {
    const eq = seg.indexOf('=');
    if (eq < 0) {
      // Bare param (vCard 2.1 style, e.g. `;HOME`) reads as a type.
      types.push(seg.trim().toLowerCase());
      continue;
    }
    const key = seg.slice(0, eq).toUpperCase();
    const val = seg.slice(eq + 1);
    params[key] = val;
    if (key === 'TYPE') for (const t of val.split(',')) types.push(t.trim().toLowerCase());
  }
  return { prop, params, types, value };
}

/** First meaningful type label (skips the vCard noise types), title-cased, or null. */
function labelType(types: string[]): string | null {
  const skip = new Set(['internet', 'voice', 'pref', 'x-pref']);
  const t = types.find((x) => x && !skip.has(x));
  if (!t) return null;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Build a renderable image source from a PHOTO line (data: URI, URL, or base64). */
function photoSrc(line: VLine): string | null {
  const v = line.value.trim();
  if (!v) return null;
  if (/^(data:|https?:)/i.test(v)) return v;
  // vCard 3.0 inline: `PHOTO;ENCODING=b;TYPE=JPEG:<base64>`.
  const enc = (line.params.ENCODING ?? '').toLowerCase();
  if (enc === 'b' || enc === 'base64') {
    const kind = line.types.find((t) => t && t !== 'pref') ?? 'jpeg';
    return `data:image/${kind};base64,${v.replace(/\s+/g, '')}`;
  }
  return null;
}

/** Parse a full vCard into the rich `CardDetail` used by the detail page + editor. */
export function parseCardDetail(vcard: string): CardDetail {
  const detail: CardDetail = {
    uid: null,
    name: null,
    nickname: null,
    org: null,
    title: null,
    emails: [],
    phones: [],
    urls: [],
    addresses: [],
    birthday: null,
    note: null,
    categories: [],
    photo: null,
  };
  let structuredName: string | null = null;

  for (const raw of unfold(vcard)) {
    const line = parseLine(raw);
    if (!line) continue;
    const { prop, value, types } = line;
    switch (prop) {
      case 'UID':
        detail.uid = unescapeText(value);
        break;
      case 'FN':
        detail.name = unescapeText(value);
        break;
      case 'N':
        if (!structuredName) {
          const [family = '', given = ''] = value.split(';').map(unescapeText);
          structuredName = `${given} ${family}`.trim() || null;
        }
        break;
      case 'NICKNAME':
        detail.nickname = unescapeText(value) || null;
        break;
      case 'ORG':
        // ORG is `Company;Department;…`; the first component is the company.
        detail.org = unescapeText(value.split(';')[0] ?? value) || null;
        break;
      case 'TITLE':
        detail.title = unescapeText(value) || null;
        break;
      case 'EMAIL': {
        const e = unescapeText(value);
        if (e) detail.emails.push(e);
        break;
      }
      case 'TEL': {
        const v = unescapeText(value);
        if (v) detail.phones.push({ type: labelType(types), value: v });
        break;
      }
      case 'URL': {
        const v = unescapeText(value);
        if (v) detail.urls.push({ type: labelType(types), value: v });
        break;
      }
      case 'ADR': {
        // ADR = po-box;ext;street;locality;region;postal;country.
        const p = value.split(';').map(unescapeText);
        const adr: VCardAddress = {
          type: labelType(types),
          street: p[2] ?? '',
          locality: p[3] ?? '',
          region: p[4] ?? '',
          postalCode: p[5] ?? '',
          country: p[6] ?? '',
        };
        if (adr.street || adr.locality || adr.region || adr.postalCode || adr.country)
          detail.addresses.push(adr);
        break;
      }
      case 'BDAY':
        detail.birthday = unescapeText(value) || null;
        break;
      case 'NOTE':
        detail.note = unescapeText(value) || null;
        break;
      case 'CATEGORIES':
        detail.categories = value.split(',').map(unescapeText).filter(Boolean);
        break;
      case 'PHOTO':
        if (!detail.photo) detail.photo = photoSrc(line);
        break;
      default:
        break;
    }
  }

  if (!detail.name) detail.name = structuredName;
  return detail;
}

/** Split a `.vcf` file (one or many cards) into individual vCard documents. */
export function splitVCards(text: string): string[] {
  // Match each BEGIN:VCARD…END:VCARD block (case-insensitive, across folds).
  return (text.match(/BEGIN:VCARD[\s\S]*?END:VCARD/gi) ?? []).map((c) => c.trim());
}

/** Narrow a parsed `CardDetail` to the editable subset (drops UID; carries PHOTO through). */
export function toEditableCard(d: CardDetail): EditableCard {
  return {
    name: d.name,
    nickname: d.nickname,
    org: d.org,
    title: d.title,
    emails: d.emails,
    phones: d.phones,
    urls: d.urls,
    addresses: d.addresses,
    birthday: d.birthday,
    note: d.note,
    categories: d.categories,
    // Keep the photo so a round-trip / import re-emits it rather than silently dropping it.
    photo: d.photo,
  };
}

/**
 * Serialise a renderable photo source to a vCard 3.0 PHOTO line, or null when unusable.
 * A `data:image/*;base64,…` URI becomes the inline `PHOTO;ENCODING=b;TYPE=…` form that
 * {@link photoSrc} reads back; an `https:` URL becomes a `PHOTO;VALUE=URI` reference.
 */
function photoLine(src: string): string | null {
  const s = src.trim();
  if (!s) return null;
  const data = /^data:image\/([a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(s);
  if (data) {
    const kind = (data[1] || 'jpeg').toUpperCase();
    const b64 = data[2]!.replace(/\s+/g, '');
    return b64 ? `PHOTO;ENCODING=b;TYPE=${kind}:${b64}` : null;
  }
  if (/^https?:/i.test(s)) return `PHOTO;VALUE=URI:${s}`;
  return null;
}

/** Property keys maily owns; a build/merge rewrites exactly these and keeps the rest. */
const MANAGED_PROPS = new Set([
  'FN',
  'N',
  'NICKNAME',
  'ORG',
  'TITLE',
  'EMAIL',
  'TEL',
  'URL',
  'ADR',
  'BDAY',
  'NOTE',
  'CATEGORIES',
]);

/** Serialise the managed properties of an editable card to vCard lines (no UID/PHOTO). */
function managedLines(card: EditableCard): string[] {
  const fn = (card.name ?? '').trim();
  const parts = fn ? fn.split(/\s+/) : [];
  const family = parts.length > 1 ? parts[parts.length - 1]! : '';
  const given = parts.length > 1 ? parts.slice(0, -1).join(' ') : fn;
  const lines: string[] = [
    `FN:${escapeValue(fn)}`,
    `N:${escapeValue(family)};${escapeValue(given)};;;`,
  ];
  if (card.nickname?.trim()) lines.push(`NICKNAME:${escapeValue(card.nickname.trim())}`);
  if (card.org?.trim()) lines.push(`ORG:${escapeValue(card.org.trim())};`);
  if (card.title?.trim()) lines.push(`TITLE:${escapeValue(card.title.trim())}`);
  for (const e of card.emails) {
    const v = e.trim();
    if (v) lines.push(`EMAIL;TYPE=INTERNET:${escapeValue(v)}`);
  }
  for (const p of card.phones) {
    const v = p.value.trim();
    if (!v) continue;
    const type = p.type?.trim() ? `;TYPE=${escapeValue(p.type.trim().toUpperCase())}` : '';
    lines.push(`TEL${type}:${escapeValue(v)}`);
  }
  for (const u of card.urls) {
    const v = u.value.trim();
    if (!v) continue;
    const type = u.type?.trim() ? `;TYPE=${escapeValue(u.type.trim().toUpperCase())}` : '';
    lines.push(`URL${type}:${escapeValue(v)}`);
  }
  for (const a of card.addresses) {
    if (!(a.street || a.locality || a.region || a.postalCode || a.country)) continue;
    const type = a.type?.trim() ? `;TYPE=${escapeValue(a.type.trim().toUpperCase())}` : '';
    const adr = [
      '',
      '',
      escapeValue(a.street),
      escapeValue(a.locality),
      escapeValue(a.region),
      escapeValue(a.postalCode),
      escapeValue(a.country),
    ].join(';');
    lines.push(`ADR${type}:${adr}`);
  }
  if (card.birthday?.trim()) lines.push(`BDAY:${escapeValue(card.birthday.trim())}`);
  if (card.note?.trim()) lines.push(`NOTE:${escapeValue(card.note.trim())}`);
  const cats = card.categories.map((c) => c.trim()).filter(Boolean);
  if (cats.length) lines.push(`CATEGORIES:${cats.map(escapeValue).join(',')}`);
  return lines;
}

/**
 * Build a vCard 3.0 document from scratch (card creation). 3.0 is the most broadly
 * compatible with Radicale and other clients. `N` is derived best-effort from the name.
 */
export function buildVCard(uid: string, card: EditableCard): string {
  const photo = typeof card.photo === 'string' ? photoLine(card.photo) : null;
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `UID:${escapeValue(uid)}`,
    ...managedLines(card),
    ...(photo ? [photo] : []),
    'END:VCARD',
  ];
  return lines.join('\r\n') + '\r\n';
}

/**
 * Round-trip an edit into an existing raw vCard: rewrite the properties maily owns
 * (`MANAGED_PROPS`) from `card`, but keep every other line (UID, VERSION, PHOTO, REV,
 * X-* extensions) exactly as Radicale served it — so unmodelled data isn't lost on save.
 * Falls back to a from-scratch build when the raw is missing/garbled.
 */
export function mergeVCard(uid: string, raw: string | null, card: EditableCard): string {
  if (!raw || !/BEGIN:VCARD/i.test(raw)) return buildVCard(uid, card);
  const kept: string[] = [];
  let inserted = false;
  const managed = managedLines(card);
  // PHOTO is rewritten only when the edit explicitly sets it (string) or clears it (null);
  // an omitted photo (undefined) leaves the card's existing PHOTO line untouched below.
  const managePhoto = card.photo !== undefined;
  const newPhoto = typeof card.photo === 'string' ? photoLine(card.photo) : null;

  for (const physical of unfold(raw)) {
    const line = parseLine(physical);
    const prop = line?.prop ?? physical.split(/[;:]/)[0]!.toUpperCase();
    if (prop === 'BEGIN' || prop === 'END') continue; // re-emitted by the wrapper
    if (managePhoto && prop === 'PHOTO') continue; // drop the old photo; re-added below
    if (line && MANAGED_PROPS.has(prop)) {
      // Drop the old managed line; splice the rebuilt block in at the first hit so
      // managed props stay grouped roughly where they were.
      if (!inserted) {
        kept.push(...managed);
        inserted = true;
      }
      continue;
    }
    kept.push(physical);
  }
  if (!inserted) kept.push(...managed);
  if (managePhoto && newPhoto) kept.push(newPhoto);

  return ['BEGIN:VCARD', ...kept, 'END:VCARD'].join('\r\n') + '\r\n';
}
