/**
 * Duplicate detection over the cached address books (ROADMAP §A2).
 *
 * Deliberately **passive**: this module only describes clusters that look like the same
 * person. Nothing here writes, queues, or nags — the UI shows the flag, and merging is a
 * separate, explicitly confirmed action (see `merge.ts`). That is the anti-chore stance:
 * a duplicate is information the user may act on, never a task list they must clear.
 *
 * Two cards cluster when they share an email address, or when their display names are
 * identical after normalisation. Matching is transitive (A–B by address, B–C by name puts
 * all three together) because a real duplicate chain is one person, not three findings.
 */
import type { ContactCardDto, ContactDuplicateGroupDto } from '@maily/shared';

/** Fold a display name to its comparison form: case, accents, and spacing are noise. */
export function normalizeName(name: string | null): string {
  return (name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Lowercased address, or null when the entry is blank. */
function normalizeEmail(email: string): string | null {
  return email.trim().toLowerCase() || null;
}

/**
 * How much of a card is filled in. Ranks cluster members so the UI defaults the fullest
 * card as the merge survivor — merging into the richest card is the least destructive
 * default even though every field is unioned anyway.
 */
export function cardRichness(card: ContactCardDto): number {
  return (
    card.emails.length +
    card.phones.length +
    card.urls.length +
    card.addresses.length +
    card.categories.length +
    [card.name, card.nickname, card.org, card.title, card.birthday, card.note, card.photo].filter(
      Boolean,
    ).length
  );
}

/** Disjoint-set over card indices — the transitive part of the clustering. */
class Groups {
  private parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) root = this.parent[root]!;
    // Path compression, so a long duplicate chain doesn't re-walk on every lookup.
    let cur = i;
    while (this.parent[cur] !== root) {
      const next = this.parent[cur]!;
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

/**
 * Cluster the cards that look duplicated. Groups are ordered by display name and their
 * members fullest-first; a card that matches nothing is simply absent from the result.
 */
export function findDuplicateGroups(cards: ContactCardDto[]): ContactDuplicateGroupDto[] {
  const groups = new Groups(cards.length);

  // Link by shared address, then by identical normalised name.
  const firstByEmail = new Map<string, number>();
  const firstByName = new Map<string, number>();
  cards.forEach((card, i) => {
    for (const raw of card.emails) {
      const email = normalizeEmail(raw);
      if (!email) continue;
      const seen = firstByEmail.get(email);
      if (seen === undefined) firstByEmail.set(email, i);
      else groups.union(seen, i);
    }
    const name = normalizeName(card.name);
    if (!name) return;
    const seen = firstByName.get(name);
    if (seen === undefined) firstByName.set(name, i);
    else groups.union(seen, i);
  });

  const members = new Map<number, number[]>();
  cards.forEach((_, i) => {
    const root = groups.find(i);
    const list = members.get(root);
    if (list) list.push(i);
    else members.set(root, [i]);
  });

  const out: ContactDuplicateGroupDto[] = [];
  for (const idxs of members.values()) {
    if (idxs.length < 2) continue;
    const group = idxs
      .map((i) => cards[i]!)
      .sort(
        (a, b) => cardRichness(b) - cardRichness(a) || (a.name ?? '').localeCompare(b.name ?? ''),
      );

    // Which addresses actually repeat across the cluster's cards (per card, so a card
    // listing one address twice doesn't look like a match with itself).
    const emailUses = new Map<string, number>();
    for (const card of group) {
      for (const email of new Set(card.emails.map(normalizeEmail).filter(Boolean) as string[])) {
        emailUses.set(email, (emailUses.get(email) ?? 0) + 1);
      }
    }
    const sharedEmails = [...emailUses.entries()]
      .filter(([, n]) => n > 1)
      .map(([email]) => email)
      .sort();

    const names = new Set(group.map((c) => normalizeName(c.name)));
    const sharedName = names.size === 1 && !names.has('') ? (group[0]!.name ?? null) : null;

    out.push({
      id: group
        .map((c) => c.uid)
        .sort()
        .join('|'),
      sharedEmails,
      sharedName,
      cards: group,
    });
  }

  return out.sort((a, b) =>
    (a.sharedName ?? a.sharedEmails[0] ?? '').localeCompare(
      b.sharedName ?? b.sharedEmails[0] ?? '',
    ),
  );
}
