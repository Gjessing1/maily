/**
 * Trigger-maintained versions for cached read models. Unlike process-local signals, these
 * counters observe writes made by every SQLite connection, including the sync worker.
 */
import type Database from 'better-sqlite3';
import { sqlite } from './client.js';

export type DataVersionScope = 'cleanup';

let readVersion: Database.Statement<[DataVersionScope]> | undefined;

/** Current durable version for a read-model scope. Migrations run before the first call. */
export function dataVersion(scope: DataVersionScope): number {
  readVersion ??= sqlite.prepare('SELECT version FROM data_versions WHERE scope = ?');
  const row = readVersion.get(scope) as { version: number } | undefined;
  if (!row) throw new Error(`missing data version scope: ${scope}`);
  return row.version;
}
