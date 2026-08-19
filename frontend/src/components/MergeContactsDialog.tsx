/**
 * Merge review for a duplicate cluster (ROADMAP §A2). The merge itself is a one-call
 * server operation; this sheet exists so it is never an *automatic* one — the user picks
 * which card survives, sees exactly what the merged card will contain and which cards are
 * deleted, and confirms. Duplicate detection stays a passive flag; this is the only place
 * a card is ever rewritten because of it.
 *
 * The preview mirrors the server's union rules (`backend/src/contacts/merge.ts`): lists
 * combine, scalars take the survivor and fall back to the others, notes concatenate. It is
 * a preview, not the source of truth — the server merges again from its own cached cards.
 */
import { useState } from 'react';
import type { ContactCardDto, ContactDuplicateGroupDto } from '@maily/shared';
import { api } from '../api/client';
import { useBackHandler } from '../state/backButton';
import { invalidateContactLookup } from '../state/contactLookup';
import { avatarHue, initials } from '../ui/format';
import { Spinner } from '../ui/Spinner';

/** First non-empty value in card order — the survivor leads, so it wins. */
function firstOf(values: (string | null)[]): string | null {
  for (const v of values) {
    const t = v?.trim();
    if (t) return t;
  }
  return null;
}

/** Union a list of values, deduping case-insensitively and keeping the first spelling. */
function unionBy<T>(lists: T[][], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const list of lists) {
    for (const item of list) {
      const key = keyOf(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

/** What the merged card will hold — enough to show the user before they commit. */
function previewMerge(cards: ContactCardDto[]): {
  name: string | null;
  org: string | null;
  emails: string[];
  phones: string[];
  addresses: number;
  notes: number;
} {
  return {
    name: firstOf(cards.map((c) => c.name)),
    org: firstOf(cards.map((c) => c.org)),
    emails: unionBy(
      cards.map((c) => c.emails),
      (e) => e.trim().toLowerCase(),
    ),
    phones: unionBy(
      cards.map((c) => c.phones.map((p) => p.value)),
      (p) => p.replace(/\D/g, '') || p.trim().toLowerCase(),
    ),
    addresses: unionBy(
      cards.map((c) => c.addresses),
      (a) => [a.street, a.locality, a.postalCode, a.country].join('|').toLowerCase(),
    ).length,
    notes: new Set(cards.map((c) => c.note?.trim()).filter(Boolean)).size,
  };
}

/** One-line description of where a card lives, for telling two near-identical cards apart. */
function cardWhere(card: ContactCardDto): string {
  return card.addressbookName ?? card.addressbook ?? 'Unknown address book';
}

export function MergeContactsDialog({
  group,
  onClose,
  onMerged,
}: {
  group: ContactDuplicateGroupDto;
  onClose: () => void;
  /** Called with the surviving card's key after a successful merge. */
  onMerged: (uid: string) => void;
}) {
  // Android Back cancels the sheet rather than navigating out from under it.
  useBackHandler(true, onClose);

  // The fullest card leads the group, so it is the default survivor.
  const [primaryUid, setPrimaryUid] = useState(group.cards[0]?.uid ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const primary = group.cards.find((c) => c.uid === primaryUid) ?? group.cards[0]!;
  const others = group.cards.filter((c) => c.uid !== primary.uid);
  const preview = previewMerge([primary, ...others]);

  const merge = () => {
    setBusy(true);
    setError(null);
    api
      .mergeContactCards(
        primary.uid,
        others.map((c) => c.uid),
      )
      .then((res) => {
        invalidateContactLookup();
        if (res.undeleted.length > 0) {
          // The survivor holds everything, but a card we couldn't delete is still on the
          // server — say so rather than reporting a clean merge it will contradict.
          setError(
            `Merged, but ${res.undeleted.length} old card${
              res.undeleted.length === 1 ? '' : 's'
            } couldn’t be deleted. Try again to clear ${res.undeleted.length === 1 ? 'it' : 'them'}.`,
          );
          setBusy(false);
          return;
        }
        onMerged(res.card?.uid ?? primary.uid);
      })
      .catch((e) => {
        setError((e as Error).message);
        setBusy(false);
      });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Merge contacts"
        className="safe-bottom max-h-[90vh] w-full overflow-y-auto rounded-t-2xl bg-bg p-4 sm:max-w-lg sm:rounded-2xl"
      >
        <h2 className="text-lg font-semibold">Merge contacts</h2>
        <p className="mt-1 text-sm text-muted">
          Pick the card to keep. Every address, phone, website and note from the others is copied
          onto it, then those cards are deleted.
        </p>

        <fieldset className="mt-4 space-y-2">
          <legend className="sr-only">Card to keep</legend>
          {group.cards.map((card) => (
            <label
              key={card.uid}
              className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 ${
                card.uid === primary.uid ? 'border-accent bg-accent-soft/40' : 'border-border'
              }`}
            >
              <input
                type="radio"
                name="merge-primary"
                checked={card.uid === primary.uid}
                onChange={() => setPrimaryUid(card.uid)}
                className="shrink-0 accent-[var(--color-accent)]"
              />
              <span
                className="flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
                style={{ backgroundColor: `hsl(${avatarHue(card.emails[0] ?? card.uid)} 45% 42%)` }}
                aria-hidden="true"
              >
                {initials(card.name, card.emails[0] ?? null)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-medium">
                  {card.name || card.emails[0] || 'Unnamed contact'}
                </span>
                <span className="block truncate text-xs text-faint">
                  {cardWhere(card)}
                  {card.emails.length > 0 && ` · ${card.emails.join(', ')}`}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        <dl className="mt-4 space-y-1 rounded-lg bg-surface px-3 py-2.5 text-xs">
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-faint">Result</dt>
            <dd className="min-w-0 flex-1 break-words text-fg">
              {preview.name || '(no name)'}
              {preview.org ? ` · ${preview.org}` : ''}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-faint">Emails</dt>
            <dd className="min-w-0 flex-1 break-words text-fg">
              {preview.emails.join(', ') || '—'}
            </dd>
          </div>
          {preview.phones.length > 0 && (
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-faint">Phones</dt>
              <dd className="min-w-0 flex-1 break-words text-fg">{preview.phones.join(', ')}</dd>
            </div>
          )}
          {(preview.addresses > 0 || preview.notes > 0) && (
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-faint">Also</dt>
              <dd className="min-w-0 flex-1 break-words text-fg">
                {[
                  preview.addresses &&
                    `${preview.addresses} address${preview.addresses === 1 ? '' : 'es'}`,
                  preview.notes && `${preview.notes} note${preview.notes === 1 ? '' : 's'}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </dd>
            </div>
          )}
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-faint">Deletes</dt>
            <dd className="min-w-0 flex-1 break-words text-fg">
              {others.map((c) => `${c.name || c.emails[0] || c.uid} (${cardWhere(c)})`).join(', ')}
            </dd>
          </div>
        </dl>

        {error && <p className="mt-3 text-sm text-danger">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-sm font-medium text-muted active:bg-surface-2 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={merge}
            disabled={busy || others.length === 0}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white active:opacity-80 disabled:opacity-40"
          >
            {busy && <Spinner className="size-4" />}
            Merge {group.cards.length} contacts
          </button>
        </div>
      </div>
    </div>
  );
}
