/**
 * Pure CSV contacts codec (no I/O), the long-tail sibling of `vcard.ts`.
 *
 * Export writes Google Contacts' column layout (`E-mail 1 - Value`, `Phone 1 - Label`, …)
 * because it is the de-facto interchange format: Google, Apple and most CRMs read it.
 * Import is header-driven and tolerant: it understands Google's current and legacy
 * exports, Outlook's (`E-mail Address`, `Mobile Phone`, `Business Street`, …), our own
 * export, and plain hand-made sheets (`Name,Email,Phone`). Columns it can't place are
 * ignored. The delimiter (`,` `;` or tab) is sniffed, since Excel in comma-decimal
 * locales (e.g. Norwegian) saves `;`-separated files.
 */
import type { EditableCard, TypedValue, VCardAddress } from './vcard.js';

// ── RFC 4180 tokenizer ────────────────────────────────────────────────────────

/** Pick the delimiter that occurs most on the header line (outside quotes). */
function sniffDelimiter(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch in counts) counts[ch]!++;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]!;
  return n > 0 ? best : ',';
}

/**
 * Split CSV text into rows of fields. Handles quoted fields with embedded delimiters,
 * doubled quotes and line breaks, CRLF/LF/CR endings, and a leading UTF-8 BOM. Rows
 * that are entirely blank are dropped.
 */
export function parseCsv(input: string, delimiter?: string): string[][] {
  const text = input.replace(/^\uFEFF/, '');
  const delim = delimiter ?? sniffDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endRow = () => {
    row.push(field);
    field = '';
    if (row.some((f) => f.trim() !== '')) rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\r' || ch === '\n') {
      endRow();
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else field += ch;
    i++;
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/** Quote a field when it holds a delimiter, quote, line break, or edge whitespace. */
function csvField(value: string): string {
  return /[",;\t\r\n]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// ── Header classification ─────────────────────────────────────────────────────

type Scalar =
  | 'name'
  | 'given'
  | 'middle'
  | 'family'
  | 'nickname'
  | 'org'
  | 'title'
  /** Outlook's bare `Title` is an honorific (Mr./Ms.); only used if nothing better exists. */
  | 'weakTitle'
  | 'birthday'
  | 'note'
  | 'categories'
  | 'photo';

type Multi = 'email' | 'phone' | 'url';
type AdrPart = 'street' | 'locality' | 'region' | 'postalCode' | 'country' | 'formatted';

/** Where one CSV column's value goes on the card. */
type Slot =
  | { kind: 'scalar'; field: Scalar }
  | { kind: Multi; key: string; part: 'value' | 'label'; label?: string }
  | { kind: 'adr'; key: string; part: AdrPart | 'label'; label?: string };

/** Fold a header to its comparison form: `E-mail 1 - Value` → `email 1 value`. */
function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/e-mail/g, 'email')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const SCALARS: Record<string, Scalar> = {
  name: 'name',
  'full name': 'name',
  'display name': 'name',
  'formatted name': 'name',
  fn: 'name',
  'first name': 'given',
  'given name': 'given',
  'middle name': 'middle',
  'additional name': 'middle',
  'last name': 'family',
  'family name': 'family',
  surname: 'family',
  nickname: 'nickname',
  'organization name': 'org',
  'organization 1 name': 'org',
  organization: 'org',
  organisation: 'org',
  company: 'org',
  'company name': 'org',
  org: 'org',
  'organization title': 'title',
  'organization 1 title': 'title',
  'job title': 'title',
  role: 'title',
  title: 'weakTitle',
  birthday: 'birthday',
  bday: 'birthday',
  'birth date': 'birthday',
  'date of birth': 'birthday',
  notes: 'note',
  note: 'note',
  labels: 'categories',
  'group membership': 'categories',
  categories: 'categories',
  groups: 'categories',
  tags: 'categories',
  photo: 'photo',
};

/** Outlook-style phone column prefixes (`Mobile Phone`, `Business Fax`, …) → display label. */
const PHONE_LABELS: Record<string, string> = {
  mobile: 'Cell',
  cell: 'Cell',
  home: 'Home',
  business: 'Work',
  work: 'Work',
  other: 'Other',
  primary: 'Main',
  main: 'Main',
  'company main': 'Main',
  car: 'Car',
  pager: 'Pager',
  'home fax': 'Fax',
  'business fax': 'Fax',
  'other fax': 'Fax',
  fax: 'Fax',
  assistant: 'Assistant',
  'assistant s': 'Assistant',
};

const ADR_PARTS: Record<string, AdrPart | 'label'> = {
  street: 'street',
  'street address': 'street',
  city: 'locality',
  locality: 'locality',
  region: 'region',
  state: 'region',
  province: 'region',
  'postal code': 'postalCode',
  zip: 'postalCode',
  'zip code': 'postalCode',
  postcode: 'postalCode',
  country: 'country',
  'country region': 'country',
  formatted: 'formatted',
  label: 'label',
  type: 'label',
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Map one header to its slot, or null for a column we don't model. */
export function classifyHeader(raw: string): Slot | null {
  const h = normalizeHeader(raw);
  if (!h) return null;
  const scalar = SCALARS[h];
  if (scalar) return { kind: 'scalar', field: scalar };

  let m: RegExpExecArray | null;

  // Email: `Email`, `E-mail 2 Address`, `E-mail 1 - Value` / `- Label|Type`, `Work Email`.
  if ((m = /^emails?(?: (\d+))?(?: (value|address))?$/.exec(h)))
    return { kind: 'email', key: m[1] ?? '1', part: 'value' };
  if ((m = /^email (\d+) (label|type)$/.exec(h)))
    return { kind: 'email', key: m[1]!, part: 'label' };
  if ((m = /^(home|work|business|personal|other) email$/.exec(h)))
    return { kind: 'email', key: m[1]!, part: 'value', label: capitalize(m[1]!) };

  // Phone: Google pairs, generic `Phone`/`Telephone`, Outlook `<Kind> Phone [2]`/`<Kind> Fax`.
  if ((m = /^(?:phone|telephone|tel)(?: (\d+))?(?: (value|number))?$/.exec(h)))
    return { kind: 'phone', key: m[1] ?? '1', part: 'value' };
  if ((m = /^phone (\d+) (label|type)$/.exec(h)))
    return { kind: 'phone', key: m[1]!, part: 'label' };
  if ((m = /^(.+?) (phone|fax|number)(?: (\d+))?$/.exec(h))) {
    const prefix = m[2] === 'fax' ? `${m[1]} fax` : m[1]!;
    const label = PHONE_LABELS[prefix];
    if (label) return { kind: 'phone', key: `${prefix}${m[3] ?? ''}`, part: 'value', label };
  }
  if (h === 'mobile' || h === 'cell' || h === 'pager' || h === 'fax')
    return { kind: 'phone', key: h, part: 'value', label: PHONE_LABELS[h] };

  // Website: Google pairs, Outlook `Web Page` / `Personal Web Page`, generic `URL`.
  if ((m = /^(?:website|url|web page|homepage|web)(?: (\d+))?(?: (value|url))?$/.exec(h)))
    return { kind: 'url', key: m[1] ?? '1', part: 'value' };
  if ((m = /^website (\d+) (label|type)$/.exec(h)))
    return { kind: 'url', key: m[1]!, part: 'label' };
  if ((m = /^(personal|business|home|work) web page$/.exec(h)))
    return { kind: 'url', key: m[1]!, part: 'value', label: m[1] === 'personal' ? 'Home' : 'Work' };

  // Address: Google `Address 1 - Street`, Outlook `Business Street 2` / `Home City`, or
  // a lone `Street`/`City`/… on a hand-made sheet.
  if ((m = /^address (\d+) (.+)$/.exec(h))) {
    const part = ADR_PARTS[m[2]!];
    if (part) return { kind: 'adr', key: m[1]!, part };
  }
  if ((m = /^(home|business|work|other) (.+?)(?: \d)?$/.exec(h))) {
    const part = ADR_PARTS[m[2]!];
    if (part && part !== 'label')
      return {
        kind: 'adr',
        key: m[1]!,
        part,
        label: m[1] === 'business' ? 'Work' : capitalize(m[1]!),
      };
  }
  if (h === 'address') return { kind: 'adr', key: '1', part: 'formatted' };
  const bare = ADR_PARTS[h];
  if (bare && bare !== 'label' && bare !== 'formatted')
    return { kind: 'adr', key: '1', part: bare };

  return null;
}

// ── Value cleanup ─────────────────────────────────────────────────────────────

/** Google packs several values into one cell as `a ::: b`. */
function splitMulti(v: string): string[] {
  return v
    .split(/\s*:::\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Google marks the primary entry's label with a leading `* `; drop it. */
function cleanLabel(v: string | undefined): string | null {
  const t = (v ?? '').replace(/^\*\s*/, '').trim();
  return t ? capitalize(t) : null;
}

/**
 * Normalise a birthday to ISO where the shape is unambiguous: `YYYY-MM-DD` and Google's
 * yearless `--MM-DD` pass through; Outlook's US `M/D/YYYY` and the European `D.M.YYYY`
 * are converted; Outlook's `0/0/00` "no birthday" placeholder becomes null. Anything
 * else is kept verbatim (vCard BDAY tolerates free text).
 */
export function normalizeBirthday(raw: string): string | null {
  const v = raw.trim();
  if (!v || /^0+\/0+\/0+$/.test(v)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v) || /^--\d{2}-\d{2}$/.test(v)) return v;
  const pad = (n: string) => n.padStart(2, '0');
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (m) return `${m[3]}-${pad(m[1]!)}-${pad(m[2]!)}`;
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v);
  if (m) return `${m[3]}-${pad(m[2]!)}-${pad(m[1]!)}`;
  return v;
}

/** Category cell → list. Google's system groups (`* myContacts`, `* starred`) are dropped. */
function splitCategories(v: string): string[] {
  const parts = v.includes(':::') ? v.split(':::') : v.split(/[,;]/);
  return parts.map((s) => s.trim()).filter((s) => s && !s.startsWith('*'));
}

// ── Import ────────────────────────────────────────────────────────────────────

/** Turn one data row into a card using the pre-classified header slots. */
function rowToCard(row: string[], slots: (Slot | null)[], hasStrongTitle: boolean): EditableCard {
  const scalars: Partial<Record<Scalar, string>> = {};
  const multis: Record<Multi, Map<string, { values: string[]; label: string | null }>> = {
    email: new Map(),
    phone: new Map(),
    url: new Map(),
  };
  const adrs = new Map<string, Partial<Record<AdrPart, string[]>> & { label?: string | null }>();

  slots.forEach((slot, i) => {
    const value = (row[i] ?? '').trim();
    if (!slot || !value) return;
    if (slot.kind === 'scalar') {
      // First non-empty column wins (e.g. `Organization 1 - Name` over `Company`).
      if (!scalars[slot.field]) scalars[slot.field] = value;
      return;
    }
    if (slot.kind === 'adr') {
      const entry = adrs.get(slot.key) ?? { label: slot.label ?? null };
      if (slot.part === 'label') entry.label = cleanLabel(value);
      else (entry[slot.part] ??= []).push(value);
      adrs.set(slot.key, entry);
      return;
    }
    const entry = multis[slot.kind].get(slot.key) ?? { values: [], label: slot.label ?? null };
    if (slot.part === 'label') entry.label = cleanLabel(value) ?? entry.label;
    else entry.values.push(...splitMulti(value));
    multis[slot.kind].set(slot.key, entry);
  });

  const typed = (kind: Multi): TypedValue[] => {
    const out: TypedValue[] = [];
    for (const { values, label } of multis[kind].values()) {
      for (const value of values) out.push({ type: label, value });
    }
    return out;
  };

  const addresses: VCardAddress[] = [];
  for (const a of adrs.values()) {
    const join = (p?: string[]) => (p ?? []).join(', ');
    const adr: VCardAddress = {
      type: a.label ?? null,
      // Outlook splits the street over `Street`, `Street 2`, `Street 3`.
      street: (a.street ?? []).join('\n'),
      locality: join(a.locality),
      region: join(a.region),
      postalCode: join(a.postalCode),
      country: join(a.country),
    };
    // A pre-formatted block only stands in when there are no structured parts.
    if (!(adr.street || adr.locality || adr.region || adr.postalCode || adr.country))
      adr.street = join(a.formatted);
    if (adr.street || adr.locality || adr.region || adr.postalCode || adr.country)
      addresses.push(adr);
  }

  const composed = [scalars.given, scalars.middle, scalars.family].filter(Boolean).join(' ');
  const photo = scalars.photo && /^https?:/i.test(scalars.photo) ? scalars.photo : undefined;

  return {
    name: scalars.name || composed || null,
    nickname: scalars.nickname ?? null,
    org: scalars.org ?? null,
    title: scalars.title ?? (hasStrongTitle ? null : (scalars.weakTitle ?? null)),
    emails: typed('email').map((e) => e.value),
    phones: typed('phone'),
    urls: typed('url'),
    addresses,
    birthday: scalars.birthday ? normalizeBirthday(scalars.birthday) : null,
    note: scalars.note ?? null,
    categories: scalars.categories ? splitCategories(scalars.categories) : [],
    ...(photo ? { photo } : {}),
  };
}

/** Is there anything on this card worth importing? */
function hasContent(c: EditableCard): boolean {
  return Boolean(
    c.name ||
    c.org ||
    c.emails.length ||
    c.phones.length ||
    c.urls.length ||
    c.addresses.length ||
    c.note,
  );
}

/** Parse a contacts CSV (header row + one contact per row) into editable cards. */
export function csvToCards(text: string): EditableCard[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const slots = header.map(classifyHeader);
  const hasStrongTitle = slots.some((s) => s?.kind === 'scalar' && s.field === 'title');
  return rows.map((r) => rowToCard(r, slots, hasStrongTitle)).filter(hasContent);
}

// ── Export ────────────────────────────────────────────────────────────────────

/** Split a display name the same way `vcard.ts` derives `N`: last word is the family. */
function splitName(name: string | null): { given: string; family: string } {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { given: parts[0] ?? '', family: '' };
  return { given: parts.slice(0, -1).join(' '), family: parts[parts.length - 1]! };
}

/**
 * Serialise cards to a Google-Contacts-layout CSV. Numbered column groups are sized to
 * the widest card. PHOTO is left out: inline photos are large base64 blobs that bloat
 * the sheet, and the vCard export already carries them. Starts with a UTF-8 BOM so
 * Excel reads non-ASCII names (æøå) correctly; `parseCsv` strips it on the way back.
 */
export function cardsToCsv(cards: EditableCard[]): string {
  const max = (f: (c: EditableCard) => unknown[]) => Math.max(0, ...cards.map((c) => f(c).length));
  const nEmail = Math.max(
    1,
    max((c) => c.emails),
  );
  const nPhone = Math.max(
    1,
    max((c) => c.phones),
  );
  const nAdr = max((c) => c.addresses);
  const nUrl = max((c) => c.urls);

  const header = [
    'Name',
    'First Name',
    'Last Name',
    'Nickname',
    'Organization Name',
    'Organization Title',
    'Birthday',
    'Notes',
    'Labels',
  ];
  for (let i = 1; i <= nEmail; i++) header.push(`E-mail ${i} - Value`);
  for (let i = 1; i <= nPhone; i++) header.push(`Phone ${i} - Label`, `Phone ${i} - Value`);
  for (let i = 1; i <= nAdr; i++)
    header.push(
      `Address ${i} - Label`,
      `Address ${i} - Street`,
      `Address ${i} - City`,
      `Address ${i} - Region`,
      `Address ${i} - Postal Code`,
      `Address ${i} - Country`,
    );
  for (let i = 1; i <= nUrl; i++) header.push(`Website ${i} - Label`, `Website ${i} - Value`);

  const lines = [header];
  for (const c of cards) {
    const { given, family } = splitName(c.name);
    const row = [
      c.name ?? '',
      given,
      family,
      c.nickname ?? '',
      c.org ?? '',
      c.title ?? '',
      c.birthday ?? '',
      c.note ?? '',
      c.categories.join(' ::: '),
    ];
    for (let i = 0; i < nEmail; i++) row.push(c.emails[i] ?? '');
    for (let i = 0; i < nPhone; i++) row.push(c.phones[i]?.type ?? '', c.phones[i]?.value ?? '');
    for (let i = 0; i < nAdr; i++) {
      const a = c.addresses[i];
      row.push(
        a?.type ?? '',
        a?.street ?? '',
        a?.locality ?? '',
        a?.region ?? '',
        a?.postalCode ?? '',
        a?.country ?? '',
      );
    }
    for (let i = 0; i < nUrl; i++) row.push(c.urls[i]?.type ?? '', c.urls[i]?.value ?? '');
    lines.push(row);
  }
  return '\uFEFF' + lines.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}
