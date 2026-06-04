/**
 * Server config + UI preferences. Config exposes only non-secret settings; prefs are
 * stored verbatim (client owns the schema) and synced across devices (ROADMAP §B).
 */
import type { FastifyInstance } from 'fastify';
import type { ServerConfigDto } from '@maily/shared';
import { env } from '../../env.js';
import { getPrefs as getStoredPrefs, putPrefs as putStoredPrefs } from '../../db/settings.js';

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // Non-secret server config (Settings → Storage shows the server cache window).
  app.get(
    '/api/config',
    async (): Promise<ServerConfigDto> => ({
      cacheWindowDays: env.cacheWindowDays,
    }),
  );

  // UI preferences, persisted server-side so they sync across devices (ROADMAP §B).
  // The client owns the schema; the server stores the object verbatim (never secrets).
  app.get('/api/settings', async () => getStoredPrefs());

  app.put<{ Body: Record<string, unknown> }>('/api/settings', async (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.code(400).send({ error: 'settings object required' });
    }
    putStoredPrefs(body);
    return { ok: true };
  });
}
