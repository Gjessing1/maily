/**
 * "Is this address already in the address book?" for the reader (ROADMAP §A2).
 *
 * The question is asked once per message opened, and a thread asks it once per sender, so
 * the answers are memoised per address at module level (the same shape Search's session
 * cache uses) and concurrent asks for one address share a single request. The address book
 * changes rarely and only through this app, so every write path calls
 * {@link invalidateContactLookup} rather than the cache trying to expire itself.
 */
import { useEffect, useState } from 'react';
import type { ContactCardDto } from '@maily/shared';
import { api } from '../api/client';

/** Resolved answers, keyed by lowercased address. */
const cache = new Map<string, ContactCardDto[]>();
/** In-flight requests, so two message cards with the same sender make one call. */
const inflight = new Map<string, Promise<ContactCardDto[]>>();

/** Drop every memoised answer — call after any card create/edit/delete/merge. */
export function invalidateContactLookup(): void {
  cache.clear();
  inflight.clear();
}

/** Cards filing `email`, from the memo if it's there and from the server otherwise. */
export function lookupContact(email: string): Promise<ContactCardDto[]> {
  const key = email.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending;

  const request = api
    .contactLookup(key)
    .then((res) => {
      cache.set(key, res.cards);
      return res.cards;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}

/**
 * Cards filing `address`: `undefined` while unknown (not yet asked, still loading, or the
 * lookup failed), an array once answered. Callers render nothing on `undefined` — an
 * offline reader should show no prompt rather than a wrong one.
 */
export function useContactLookup(address: string | null | undefined): ContactCardDto[] | undefined {
  const key = address?.trim().toLowerCase() ?? '';
  const [cards, setCards] = useState<ContactCardDto[] | undefined>(() =>
    key ? cache.get(key) : undefined,
  );

  useEffect(() => {
    if (!key) {
      setCards(undefined);
      return;
    }
    const hit = cache.get(key);
    if (hit) {
      setCards(hit);
      return;
    }
    let live = true;
    setCards(undefined);
    lookupContact(key)
      .then((res) => {
        if (live) setCards(res);
      })
      .catch(() => {
        // Offline or unauthorized — stay silent rather than claiming the sender is unknown.
      });
    return () => {
      live = false;
    };
  }, [key]);

  return cards;
}
