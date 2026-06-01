/**
 * Applies pending Drizzle migrations, then exits. Run via `npm run db:migrate`.
 */
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db, sqlite } from './client.js';

migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });
sqlite.close();
console.log('Migrations applied.');
