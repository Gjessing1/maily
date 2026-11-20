import { sql, type SQL } from 'drizzle-orm';

const RECENCY_HALF_LIFE_MS = 90 * 86_400_000;
const RECENCY_BOOST = 0.5;
const EXACT_MATCH_BOOST = 0.35;
const FLAGGED_BOOST = 0.05;

export const searchDate = sql`coalesce(m.received_at, m.sent_at)`;

/** Score each eligible FTS hit before applying the result limit. */
export function keywordScore(exactMatch: string, now = Date.now()): SQL {
  // FTS column order: message ID, subject, sender name, sender address, plain body, HTML text.
  const relevance = sql`-bm25(messages_fts, 0, 8, 4, 3, 1, 1)`;
  const recency = sql`coalesce(1.0 / (1.0 + max(0, ${now} - ${searchDate})
    / (1.0 * ${RECENCY_HALF_LIFE_MS})), 0)`;
  // An exact token or phrase gets a fixed bonus independent of its frequency in the index.
  const exact = sql`CASE WHEN messages_fts.rowid IN (
    SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${exactMatch}
  ) THEN ${EXACT_MATCH_BOOST} ELSE 0 END`;

  return sql`${relevance} * (1 + ${exact} + ${RECENCY_BOOST} * ${recency} + ${FLAGGED_BOOST} * m.flagged)`;
}
