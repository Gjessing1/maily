/**
 * Settings over HTTP — three documents with different owners:
 * - `/api/config`: non-secret server config from the environment, read-only.
 * - `/api/settings`: the client-owned UI prefs, synced across devices by top-level merge patch.
 * - `/api/settings/server`: typed settings the server acts on, validated before they're stored.
 *
 * Every write emits `settings:changed` so other open clients re-read.
 */
import type { FastifyInstance } from 'fastify';
import type { ServerConfigDto, ServerSettings } from '@maily/shared';
import { env } from '../../env.js';
import { emitSignal } from '../../events.js';
import {
  getPrefs,
  getServerSettings,
  parseServerSettingsPatch,
  patchPrefs,
  patchServerSettings,
} from '../../db/settings.js';

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // Non-secret server config (Settings → Storage shows the server cache window).
  app.get(
    '/api/config',
    async (): Promise<ServerConfigDto> => ({
      cacheWindowDays: env.cacheWindowDays,
      buildId: env.buildId,
    }),
  );

  app.get('/api/settings', async () => getPrefs());

  // Each key in the body replaces its stored value; null removes it. Keys not sent are untouched.
  app.patch<{ Body: Record<string, unknown> }>('/api/settings', async (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.code(400).send({ error: 'settings object required' });
    }
    patchPrefs(body);
    emitSignal({ type: 'settings:changed' });
    return { ok: true };
  });

  app.get('/api/settings/server', async (): Promise<ServerSettings> => getServerSettings());

  app.patch<{ Body: unknown }>('/api/settings/server', async (req, reply) => {
    const parsed = parseServerSettingsPatch(req.body);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    const settings = patchServerSettings(parsed.patch);
    emitSignal({ type: 'settings:changed' });
    return settings;
  });
}
