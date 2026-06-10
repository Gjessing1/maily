-- messages.content_bytes: byte size of the parsed body (body_text + body_html),
-- computed at write time (imap/store.ts) and backfilled here. The cleanup storage
-- metric (backend/src/cleanup/slices.ts `BYTES`) and the Settings per-account size
-- (db/queries.ts) previously computed length() over the body columns inside their
-- aggregates, which forces SQLite to read and decode every body (~hundreds of MB)
-- on every dashboard visit — measured at 15-20s on the live DB. Summing a small
-- integer column instead takes milliseconds. Nullable: NULL means "written before
-- this column existed" and falls back to the live length() expression, so a missed
-- write path under-performs but never under-counts.
ALTER TABLE `messages` ADD `content_bytes` integer;
--> statement-breakpoint
-- The unconditional AFTER UPDATE trigger (migration 0003) would delete + reinsert
-- every FTS row during the backfill below (a full index rewrite for a no-op content
-- change), so drop it for the duration and recreate it verbatim afterwards.
DROP TRIGGER `messages_fts_au`;
--> statement-breakpoint
UPDATE `messages` SET `content_bytes` =
  length(CAST(coalesce(`body_text`, '') AS BLOB)) + length(CAST(coalesce(`body_html`, '') AS BLOB));
--> statement-breakpoint
CREATE TRIGGER `messages_fts_au` AFTER UPDATE ON `messages` BEGIN
  DELETE FROM `messages_fts` WHERE message_id = old.id;
  INSERT INTO `messages_fts`(message_id, subject, from_name, from_address, body)
  VALUES (new.id, new.subject, new.from_name, new.from_address, coalesce(new.body_text, new.snippet, ''));
END;
