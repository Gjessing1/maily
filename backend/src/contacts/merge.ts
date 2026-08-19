/**
 * Field union for a contact merge (ROADMAP §A2). Pure and side-effect free: it decides
 * *what* the surviving card should contain, while the route decides *when* — merging only
 * ever happens on an explicit, confirmed request, never as a background tidy-up.
 *
 * The rule throughout is **never lose data**: scalars take the first card that has one
 * (the survivor wins ties), and every list is unioned rather than replaced. That is why a
 * merge needs no per-field wizard — nothing the user typed on the folded-in cards is
 * dropped, so the only decision left is which card survives.
 */
import type { ContactCardDto, ContactAddressDto, TypedValueDto } from '@maily/shared';
import type { EditableCard } from './vcard.js';

/** First non-empty value in card order — the survivor is passed first, so it wins. */
function firstOf(values: (string | null | undefined)[]): string | null {
  for (const v of values) {
    const t = v?.trim();
    if (t) return t;
  }
  return null;
}

/** A phone's identity for dedup: its digits. `+47 22 00 00 00` == `+4722000000`. */
function phoneKey(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits || value.trim().toLowerCase();
}

/** A URL's identity for dedup: scheme-insensitive, trailing slash ignored. */
function urlKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

/** An address's identity for dedup: its components, normalised and joined. */
function addressKey(a: ContactAddressDto): string {
  return [a.street, a.locality, a.region, a.postalCode, a.country]
    .map((c) => c.trim().toLowerCase().replace(/\s+/g, ' '))
    .join('|');
}

/** Union a labelled-value list, keeping the first entry (and its label) per identity. */
function unionTyped(lists: TypedValueDto[][], keyOf: (value: string) => string): TypedValueDto[] {
  const seen = new Set<string>();
  const out: TypedValueDto[] = [];
  for (const list of lists) {
    for (const item of list) {
      const value = item.value?.trim();
      if (!value) continue;
      const key = keyOf(value);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type: item.type?.trim() || null, value });
    }
  }
  return out;
}

/**
 * Fold `cards` into the fields of a single card. `cards[0]` is the survivor: it supplies
 * every scalar it has and leads each list, with the remaining cards appended in order.
 *
 * PHOTO is tri-state on the wire, and `undefined` here means "leave the survivor's alone".
 * A merge only ever *supplies* a photo — it never clears one — so a survivor that already
 * has one keeps it untouched rather than being rewritten with an identical value.
 */
export function mergeCards(cards: ContactCardDto[]): EditableCard {
  const [primary, ...rest] = cards;
  if (!primary) throw new Error('mergeCards needs at least one card');
  const all = [primary, ...rest];

  const emailSeen = new Set<string>();
  const emails: string[] = [];
  for (const card of all) {
    for (const raw of card.emails) {
      const email = raw.trim();
      const key = email.toLowerCase();
      if (!email || emailSeen.has(key)) continue;
      emailSeen.add(key);
      emails.push(email);
    }
  }

  const categorySeen = new Set<string>();
  const categories: string[] = [];
  for (const card of all) {
    for (const raw of card.categories) {
      const category = raw.trim();
      const key = category.toLowerCase();
      if (!category || categorySeen.has(key)) continue;
      categorySeen.add(key);
      categories.push(category);
    }
  }

  const addressSeen = new Set<string>();
  const addresses: ContactAddressDto[] = [];
  for (const card of all) {
    for (const a of card.addresses) {
      const key = addressKey(a);
      if (key === '||||' || addressSeen.has(key)) continue;
      addressSeen.add(key);
      addresses.push(a);
    }
  }

  // Notes are free text: keep every distinct one, separated by a blank line, rather than
  // picking a winner — a note is the field most likely to hold the thing only one card knows.
  const noteSeen = new Set<string>();
  const notes: string[] = [];
  for (const card of all) {
    const note = card.note?.trim();
    if (!note || noteSeen.has(note)) continue;
    noteSeen.add(note);
    notes.push(note);
  }

  const photo = firstOf(all.map((c) => c.photo));

  return {
    name: firstOf(all.map((c) => c.name)),
    nickname: firstOf(all.map((c) => c.nickname)),
    org: firstOf(all.map((c) => c.org)),
    title: firstOf(all.map((c) => c.title)),
    emails,
    phones: unionTyped(
      all.map((c) => c.phones),
      phoneKey,
    ),
    urls: unionTyped(
      all.map((c) => c.urls),
      urlKey,
    ),
    addresses,
    birthday: firstOf(all.map((c) => c.birthday)),
    note: notes.length ? notes.join('\n\n') : null,
    categories,
    // Only send PHOTO when the survivor lacks one and another card supplies it; otherwise
    // omit the field so the existing PHOTO line is preserved verbatim.
    photo: primary.photo ? undefined : (photo ?? undefined),
  };
}
