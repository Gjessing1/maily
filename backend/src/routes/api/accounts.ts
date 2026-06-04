/**
 * Account + folder listing and per-account sync status (Settings → Sync).
 */
import type { FastifyInstance } from 'fastify';
import type { AccountSyncStatusDto } from '@maily/shared';
import { folderMessageCount, listAccounts, listFolders } from '../../db/queries.js';
import { allEngines } from '../../imap/registry.js';
import { toAccountDto, toFolderDto } from '../../http/dto.js';

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/accounts', async () => listAccounts().map(toAccountDto));

  app.get<{ Params: { id: string } }>('/api/accounts/:id/folders', async (req) =>
    listFolders(req.params.id).map(toFolderDto),
  );

  // Sync status: live connection + last-sync + per-folder cached counts (Settings → Sync).
  app.get('/api/sync/status', async (): Promise<AccountSyncStatusDto[]> => {
    const byId = new Map(listAccounts().map((a) => [a.id, a]));
    return allEngines().map((engine) => {
      const acc = byId.get(engine.id);
      const { connected, lastSyncAt } = engine.status;
      return {
        accountId: engine.id,
        email: acc?.email ?? '',
        provider: acc?.provider ?? '',
        connected,
        lastSyncAt,
        folders: listFolders(engine.id).map((f) => ({
          id: f.id,
          name: f.name,
          role: f.role,
          cached: folderMessageCount(f.id),
          synced: f.uidValidity !== null,
        })),
      };
    });
  });
}
