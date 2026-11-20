import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { sqlite, withWriteRetry } from '../db/client.js';
import { getSetting, putSetting } from '../db/settings.js';
import { htmlSearchText } from './body-text.js';

const BACKFILL_KEY = 'search.html-body-backfilled';
const BATCH_SIZE = 8;

interface LegacyBody {
  rowid: number;
  id: string;
  body_html: string;
  body_text: string | null;
}

/** Fill the HTML column for mail cached before the HTML index migration. */
export async function backfillHtmlBodies(): Promise<number> {
  if (getSetting(BACKFILL_KEY, false)) return 0;

  const page = sqlite.prepare<[number, number], LegacyBody>(
    `SELECT f.rowid, m.id, m.body_html, m.body_text FROM messages_fts f
     JOIN messages m ON m.id = f.message_id
     WHERE f.rowid > ? AND f.html_body IS NULL AND m.body_html IS NOT NULL
     ORDER BY f.rowid LIMIT ?`,
  );
  // Live writes index the latest body in the same transaction as the message change.
  const update = sqlite.prepare<[string, number, string]>(
    'UPDATE messages_fts SET html_body = ? WHERE rowid = ? AND message_id = ? AND html_body IS NULL',
  );
  const writeBatch = sqlite.transaction((bodies: { rowid: number; id: string; text: string }[]) => {
    let changes = 0;
    for (const body of bodies) changes += update.run(body.text, body.rowid, body.id).changes;
    return changes;
  });

  let indexed = 0;
  let after = 0;
  for (;;) {
    const rows = page.all(after, BATCH_SIZE);
    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.rowid;
    const bodies = rows.map(({ rowid, id, body_html, body_text }) => ({
      rowid,
      id,
      text: htmlSearchText(body_html, body_text),
    }));
    indexed += withWriteRetry('search body backfill', () => writeBatch(bodies));
    await yieldToLoop();
  }

  withWriteRetry('finish search body backfill', () => putSetting(BACKFILL_KEY, true));
  return indexed;
}
