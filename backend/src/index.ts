/**
 * Backend entry point.
 *
 * Phase 0 booted the data plane. Phase 1 adds the IMAP sync engine: for each
 * configured account we run one persistent INBOX IDLE connection plus a
 * non-INBOX reconcile cron (see docs/ROADMAP.md, src/imap/). The Fastify HTTP
 * server, Socket.io and Web Push arrive in later phases.
 */
import { env } from './env.js';
import { sqlite } from './db/client.js';
import { createLogger } from './logger.js';
import { loadAccountConfigs } from './config/accounts.js';
import { startSyncEngines, type AccountEngine } from './imap/engine.js';

const log = createLogger('maily');

function reportBoot(): void {
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => (row as { name: string }).name);

  log.info(`backend — ${env.nodeEnv}`);
  log.info(`  db:          ${env.dbPath}`);
  log.info(`  attachments: ${env.attachmentsDir}`);
  log.info(`  journal:     ${sqlite.pragma('journal_mode', { simple: true })}`);
  log.info(`  tables:      ${tables.length ? tables.join(', ') : '(none — run db:migrate)'}`);
}

function installShutdown(engines: AccountEngine[]): void {
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}, shutting down…`);
    await Promise.allSettled(engines.map((e) => e.stop()));
    sqlite.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function main(): void {
  reportBoot();

  const accounts = loadAccountConfigs();
  if (accounts.length === 0) {
    log.warn('no accounts configured (ACCOUNT_<n>_* env vars) — sync engine idle');
    return;
  }

  log.info(`starting sync engines for ${accounts.length} account(s)`);
  const engines = startSyncEngines(accounts);
  installShutdown(engines);
}

main();
