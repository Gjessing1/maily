/**
 * SQLite connection. WAL mode is mandatory so HTTP reads aren't blocked while the
 * background sync writes (ARCHITECTURE §12). better-sqlite3 is synchronous.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { env } from '../env.js';
import * as schema from './schema.js';

export const sqlite: Database.Database = new Database(env.dbPath);

// Performance / concurrency pragmas.
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');

export const db = drizzle(sqlite, { schema });
export type DB = typeof db;

// Synchronous sleep (no CPU spin) for the rare SQLITE_BUSY backoff below.
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

/**
 * Run a synchronous write, retrying on SQLITE_BUSY. We run sync + sweep on a worker
 * thread with its own connection, so a long worker transaction (bulk sync / source
 * sweep) can overlap a main-thread user write (flag / delete / relink). WAL +
 * `busy_timeout = 5000` already blocks-and-retries *within* one statement, so reaching
 * SQLITE_BUSY here means a writer held the lock past that timeout — rare, but possible.
 * We **log every occurrence** so the real frequency is measurable before investing in
 * anything heavier (a single-writer redesign is deliberately not warranted, §1/§12).
 */
export function withWriteRetry<T>(label: string, fn: () => T, attempts = 3): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      const code = (err as { code?: string }).code;
      const busy = code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT';
      if (busy && attempt < attempts) {
        console.warn(`[db] ${code} on "${label}" (attempt ${attempt}/${attempts}); retrying`);
        sleepSync(25 * attempt);
        continue;
      }
      throw err;
    }
  }
}
