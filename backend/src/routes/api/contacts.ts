/**
 * Contacts: composer autocomplete + full CardDAV-backed card management (Radicale is
 * the source of truth — ROADMAP §3.7.D). Writes round-trip through `contacts/carddav`.
 */
import type { FastifyInstance } from 'fastify';
import type { ContactAddressDto, ContactCardInput, TypedValueDto } from '@maily/shared';
import {
  getCardByKey,
  getCardDetail,
  listCards,
  listRawCards,
  searchContacts,
} from '../../contacts/store.js';
import {
  CardDavError,
  createCard,
  deleteCard,
  ensureDiscovered,
  importCards,
  syncContacts,
  updateCard,
} from '../../contacts/carddav.js';
import {
  parseCardDetail,
  splitVCards,
  toEditableCard,
  type EditableCard,
} from '../../contacts/vcard.js';
import { getAddressbookState, setAddressbookSettings } from '../../contacts/addressbooks.js';

/** Sanitise a labelled-value list (phones/urls): trim, drop empties, cap the label. */
function cleanTyped(items: TypedValueDto[] | undefined): TypedValueDto[] {
  return (items ?? [])
    .map((i) => ({
      type: i?.type?.toString().trim() || null,
      value: String(i?.value ?? '').trim(),
    }))
    .filter((i) => i.value);
}

/** Sanitise the address list: trim every component, drop wholly-empty entries. */
function cleanAddresses(items: ContactAddressDto[] | undefined): ContactAddressDto[] {
  return (items ?? [])
    .map((a) => ({
      type: a?.type?.toString().trim() || null,
      street: String(a?.street ?? '').trim(),
      locality: String(a?.locality ?? '').trim(),
      region: String(a?.region ?? '').trim(),
      postalCode: String(a?.postalCode ?? '').trim(),
      country: String(a?.country ?? '').trim(),
    }))
    .filter((a) => a.street || a.locality || a.region || a.postalCode || a.country);
}

/** Clean a create/update payload into the editable card + its target book. */
function normalizeCard(body: ContactCardInput | undefined): {
  card: EditableCard;
  addressbook: string | null;
} {
  const addressbook = body?.addressbook ? String(body.addressbook) : null;
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const raw of body?.emails ?? []) {
    const e = String(raw).trim();
    const key = e.toLowerCase();
    if (e && /.+@.+/.test(e) && !seen.has(key)) {
      seen.add(key);
      emails.push(e);
    }
  }
  const card: EditableCard = {
    name: body?.name?.trim() || null,
    nickname: body?.nickname?.trim() || null,
    org: body?.org?.trim() || null,
    title: body?.title?.trim() || null,
    emails,
    phones: cleanTyped(body?.phones),
    urls: cleanTyped(body?.urls),
    addresses: cleanAddresses(body?.addresses),
    birthday: body?.birthday?.trim() || null,
    note: body?.note?.trim() || null,
    categories: (body?.categories ?? []).map((c) => String(c).trim()).filter(Boolean),
  };
  return { card, addressbook };
}

export async function contactRoutes(app: FastifyInstance): Promise<void> {
  // Contact autocomplete for the composer (cached CardDAV addressbook).
  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/contacts', async (req) => {
    const q = (req.query.q ?? '').trim();
    if (!q) return [];
    const limit = Math.min(Number(req.query.limit ?? 8) || 8, 25);
    return searchContacts(q, limit);
  });

  // List discovered address books + which are active + the default create target.
  app.get('/api/contacts/addressbooks', async () => {
    await ensureDiscovered();
    return getAddressbookState();
  });

  // Set the active books / default; re-sync so the cache reflects the new selection.
  app.put<{ Body: { active?: string[] | null; default?: string | null } }>(
    '/api/contacts/addressbooks',
    async (req) => {
      const active = Array.isArray(req.body?.active) ? req.body.active.map(String) : null;
      const def = req.body?.default ? String(req.body.default) : null;
      setAddressbookSettings(active, def);
      await syncContacts();
      return getAddressbookState();
    },
  );

  // List cards for the manager UI, optionally filtered to one address book.
  app.get<{ Querystring: { addressbook?: string } }>('/api/contacts/cards', async (req) => {
    const book = req.query.addressbook;
    const cards = listCards();
    return book ? cards.filter((c) => c.addressbook === book) : cards;
  });

  // Export the cached cards as a single `.vcf` download (optionally one book).
  // Static path, so Fastify routes it ahead of `/cards/:key`.
  app.get<{ Querystring: { addressbook?: string } }>(
    '/api/contacts/cards/export',
    async (req, reply) => {
      const vcf = listRawCards(req.query.addressbook || null);
      const stamp = new Date().toISOString().slice(0, 10);
      return reply
        .header('Content-Type', 'text/vcard; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="contacts-${stamp}.vcf"`)
        .send(vcf);
    },
  );

  // Import a `.vcf` file (one or many cards) into the chosen book (or the default).
  app.post<{ Body: { addressbook?: string | null; vcard?: string } }>(
    '/api/contacts/cards/import',
    async (req, reply) => {
      const text = typeof req.body?.vcard === 'string' ? req.body.vcard : '';
      const blocks = splitVCards(text);
      if (blocks.length === 0)
        return reply.code(400).send({ error: 'no vCard found in the uploaded file' });
      const addressbook = req.body?.addressbook ? String(req.body.addressbook) : null;
      const cards: EditableCard[] = blocks.map((b) => toEditableCard(parseCardDetail(b)));
      try {
        return await importCards(addressbook, cards);
      } catch (err) {
        const status = err instanceof CardDavError ? err.status : 502;
        return reply.code(status).send({ error: (err as Error).message });
      }
    },
  );

  // Fetch one card's rich detail by key (vCard UID, or href for UID-less cards).
  app.get<{ Params: { key: string } }>('/api/contacts/cards/:key', async (req, reply) => {
    const card = getCardDetail(req.params.key);
    if (!card) return reply.code(404).send({ error: 'card not found' });
    return card;
  });

  // Create a new card in the chosen book (or the default). UID is assigned server-side.
  app.post<{ Body: ContactCardInput }>('/api/contacts/cards', async (req, reply) => {
    const { card, addressbook } = normalizeCard(req.body);
    if (card.emails.length === 0)
      return reply.code(400).send({ error: 'at least one email required' });
    try {
      const uid = await createCard(addressbook, card);
      return reply.code(201).send({ uid, ...card, addressbook });
    } catch (err) {
      const status = err instanceof CardDavError ? err.status : 502;
      return reply.code(status).send({ error: (err as Error).message });
    }
  });

  // Update an existing card by its key (vCard UID, or href for UID-less cards).
  app.put<{ Params: { key: string }; Body: ContactCardInput }>(
    '/api/contacts/cards/:key',
    async (req, reply) => {
      const existing = getCardByKey(req.params.key);
      if (!existing?.href) return reply.code(404).send({ error: 'card not found' });
      const { card } = normalizeCard(req.body);
      if (card.emails.length === 0)
        return reply.code(400).send({ error: 'at least one email required' });
      try {
        await updateCard(existing.uid, existing.href, existing.etag, existing.raw, card);
        return { uid: existing.uid, ...card };
      } catch (err) {
        const status = err instanceof CardDavError ? err.status : 502;
        return reply.code(status).send({ error: (err as Error).message });
      }
    },
  );

  // Delete a card by its key.
  app.delete<{ Params: { key: string } }>('/api/contacts/cards/:key', async (req, reply) => {
    const card = getCardByKey(req.params.key);
    if (!card?.href) return reply.code(404).send({ error: 'card not found' });
    try {
      await deleteCard(card.href);
      return { ok: true };
    } catch (err) {
      const status = err instanceof CardDavError ? err.status : 502;
      return reply.code(status).send({ error: (err as Error).message });
    }
  });
}
