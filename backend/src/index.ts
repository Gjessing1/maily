/**
 * Backend entry point.
 *
 * Phase 0: boots configuration + the SQLite/Drizzle layer to prove the data plane works.
 * The Fastify HTTP server, Socket.io, and the IMAP engine arrive in later phases
 * (see docs/ROADMAP.md).
 */
import { env } from './env.js';
import { sqlite } from './db/client.js';

function main(): void {
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => (row as { name: string }).name);

  console.log(`maily backend — ${env.nodeEnv}`);
  console.log(`  db:          ${env.dbPath}`);
  console.log(`  attachments: ${env.attachmentsDir}`);
  console.log(`  journal:     ${sqlite.pragma('journal_mode', { simple: true })}`);
  console.log(`  tables:      ${tables.length ? tables.join(', ') : '(none — run db:migrate)'}`);
}

main();
