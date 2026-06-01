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
