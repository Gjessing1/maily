/**
 * Contacts: composer autocomplete + full CardDAV-backed card management (Radicale is
 * the source of truth — ROADMAP §3.7.D). Writes round-trip through `contacts/carddav`.
 */
import type { FastifyInstance } from 'fastify';
import type { ContactCardInput } from '@maily/shared';
import { getCardByKey, listCards, searchContacts } from '../../contacts/store.js';
import { CardDavError, createCard, deleteCard, updateCard } from '../../contacts/carddav.js';

/** Clean a create/update payload into a name + a deduped list of trimmed emails. */
function normalizeCard(body: ContactCardInput | undefined): { name: string | null; emails: string[] } {
  const name = body?.name?.trim() || null;
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
  return { name, emails };
}

export async function contactRoutes(app: FastifyInstance): Promise<void> {
  // Contact autocomplete for the composer (cached CardDAV addressbook).
  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/contacts', async (req) => {
    const q = (req.query.q ?? '').trim();
    if (!q) return [];
    const limit = Math.min(Number(req.query.limit ?? 8) || 8, 25);
    return searchContacts(q, limit);
  });

  // List the whole addressbook as cards for the manager UI.
  app.get('/api/contacts/cards', async () => listCards());

  // Create a new card. UID is assigned server-side.
  app.post<{ Body: ContactCardInput }>('/api/contacts/cards', async (req, reply) => {
    const { name, emails } = normalizeCard(req.body);
    if (emails.length === 0) return reply.code(400).send({ error: 'at least one email required' });
    try {
      const uid = await createCard(name, emails);
      return reply.code(201).send({ uid, name, emails });
    } catch (err) {
      const status = err instanceof CardDavError ? err.status : 502;
      return reply.code(status).send({ error: (err as Error).message });
    }
  });

  // Update an existing card by its key (vCard UID, or href for UID-less cards).
  app.put<{ Params: { key: string }; Body: ContactCardInput }>(
    '/api/contacts/cards/:key',
    async (req, reply) => {
      const card = getCardByKey(req.params.key);
      if (!card?.href) return reply.code(404).send({ error: 'card not found' });
      const { name, emails } = normalizeCard(req.body);
      if (emails.length === 0)
        return reply.code(400).send({ error: 'at least one email required' });
      try {
        await updateCard(card.uid, card.href, card.etag, name, emails);
        return { uid: card.uid, name, emails };
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
