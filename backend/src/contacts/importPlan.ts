/**
 * Duplicate-aware import planning. Pure: it decides what an import *would* write,
 * `carddav.importCards` performs it.
 *
 * Identity is the **email address** — the one field that reliably names the same
 * person across a Google export, an Outlook sheet and Radicale. An imported entry that
 * shares an address with an existing card is folded into that card with the regular
 * merge union (`merge.ts`: nothing on the existing card is ever removed), rather than
 * filed a second time. Re-importing the same file is therefore idempotent: every entry
 * comes back `unchanged` and nothing is written.
 *
 * A matching *name* alone is deliberately not enough — two different "Kari Nordmann"s
 * must not have their addresses fused by an import nobody reviewed. Name-only lookalikes
 * are imported as new cards and surface in the passive duplicates band (`duplicates.ts`),
 * where the user decides.
 */
import type { ContactCardDto } from '@maily/shared';
import type { EditableCard } from './vcard.js';
import { cardRichness } from './duplicates.js';
import { mergeCards } from './merge.js';

export interface ImportPlan {
  /** Entries with no existing match — PUT as new cards. */
  creates: EditableCard[];
  /** Existing cards that gain data from one or more entries, with their merged fields. */
  merges: { target: ContactCardDto; card: EditableCard }[];
  /** Entries already fully present on an existing card. */
  unchanged: number;
  /** Entries dropped up front (no email address — useless to a mail client). */
  skipped: number;
}

const emailKeys = (emails: string[]) => [
  ...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean)),
];

/** Group items that share any email, transitively (A–B and B–C ⇒ one group). */
function clusterByEmail<T>(items: T[], emailsOf: (t: T) => string[]): T[][] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const firstByEmail = new Map<string, number>();
  items.forEach((item, i) => {
    for (const email of emailKeys(emailsOf(item))) {
      const seen = firstByEmail.get(email);
      if (seen === undefined) firstByEmail.set(email, i);
      else parent[find(i)] = find(seen);
    }
  });
  const groups = new Map<number, T[]>();
  items.forEach((item, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), item]);
  });
  return [...groups.values()];
}

/** Stable comparison form of a card's editable fields (PHOTO handled separately). */
function fingerprint(card: EditableCard): string {
  return JSON.stringify({ ...card, photo: undefined });
}

/**
 * Plan an import of `incoming` against the cached `existing` cards. `targetBook` is
 * where new cards will land; when an entry matches cards in several books, the copy in
 * that book is preferred, then the fullest card.
 */
export function planImport(
  incoming: EditableCard[],
  existing: ContactCardDto[],
  targetBook: string | null,
): ImportPlan {
  const plan: ImportPlan = { creates: [], merges: [], unchanged: 0, skipped: 0 };

  const withEmail = incoming.filter((c) => {
    if (emailKeys(c.emails).length > 0) return true;
    plan.skipped++;
    return false;
  });

  // 1. Fold entries within the file that share an address (a sheet listing someone
  //    twice is one person). File order decides which entry's scalars win.
  const entries = clusterByEmail(withEmail, (c) => c.emails).map((group) =>
    group.length === 1 ? group[0]! : mergeCards(group),
  );
  plan.unchanged += withEmail.length - entries.length;

  // 2. Match each folded entry to an existing card by address.
  const byEmail = new Map<string, ContactCardDto[]>();
  for (const card of existing) {
    for (const email of emailKeys(card.emails)) {
      byEmail.set(email, [...(byEmail.get(email) ?? []), card]);
    }
  }
  const rank = (c: ContactCardDto) =>
    (c.addressbook === targetBook ? 1_000_000 : 0) + cardRichness(c);

  // Several entries can land on the same existing card (one carries its work address,
  // another its private one); gather them so the card is written once, not raced.
  const perTarget = new Map<ContactCardDto, EditableCard[]>();
  for (const entry of entries) {
    const candidates = new Set<ContactCardDto>();
    for (const email of emailKeys(entry.emails)) {
      for (const card of byEmail.get(email) ?? []) candidates.add(card);
    }
    if (candidates.size === 0) {
      plan.creates.push(entry);
      continue;
    }
    const target = [...candidates].sort((a, b) => rank(b) - rank(a))[0]!;
    perTarget.set(target, [...(perTarget.get(target) ?? []), entry]);
  }

  for (const [target, group] of perTarget) {
    const merged = mergeCards([target, ...group]);
    // Nothing new when the union equals the card as it stands and no photo is supplied.
    if (merged.photo === undefined && fingerprint(merged) === fingerprint(mergeCards([target])))
      plan.unchanged += group.length;
    else plan.merges.push({ target, card: merged });
  }

  return plan;
}
