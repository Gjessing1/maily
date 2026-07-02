-- Partial index for the unread-first list fetch (`?unread=1`): `seen` was ALTER-TABLE-added,
-- so it sits AFTER body_text/body_html in each record and a plain scan pays for skipping every
-- body's overflow pages (the same trap accountContentBytes hit). Indexing received_at WHERE
-- seen = 0 keeps the unread lookup proportional to the unread count (normally near zero).
-- NOTE: partial indexes only match when the query says literally `seen = 0` — a bound
-- parameter (`seen = ?`) can NOT use it, which is why queries.ts inlines the 0.
CREATE INDEX `messages_unseen_received_idx` ON `messages` (`received_at`) WHERE `seen` = 0;
