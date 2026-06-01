/**
 * Drizzle migration runner. `runMigrations()` is called on backend startup so a
 * fresh deploy is turnkey; the same file run directly (`npm run db:migrate`)
 * applies migrations and exits.
 */
import { pathToFileURL } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db, sqlite } from './client.js';

const migrationsFolder = new URL('../../drizzle', import.meta.url).pathname;

/** Apply any pending migrations against the shared app connection (does not close it). */
export function runMigrations(): void {
  migrate(db, { migrationsFolder });
}

// Run standalone when invoked as a script (CLI), then close the connection.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations();
  sqlite.close();
  console.log('Migrations applied.');
}
