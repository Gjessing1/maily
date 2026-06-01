import { resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';

// Kept self-contained (no app imports) so drizzle-kit's config loader can run it.
const dataDir = resolve(process.env.MAILY_DATA_DIR ?? './data');
const dbPath = resolve(dataDir, process.env.MAILY_DB_FILE ?? 'mail.sqlite');

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: dbPath,
  },
});
