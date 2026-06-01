-- FTS5 full-text search over messages (ARCHITECTURE §12 — never LIKE-scan).
-- Drizzle can't model virtual tables, so this migration is hand-written.
-- Standalone (non-external-content) FTS index: stores the internal message id as
-- an UNINDEXED column so matches map straight back to the messages row.
CREATE VIRTUAL TABLE `messages_fts` USING fts5(
  message_id UNINDEXED,
  subject,
  from_name,
  from_address,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
-- Keep the index in sync with the messages table via triggers.
CREATE TRIGGER `messages_fts_ai` AFTER INSERT ON `messages` BEGIN
  INSERT INTO `messages_fts`(message_id, subject, from_name, from_address, body)
  VALUES (new.id, new.subject, new.from_name, new.from_address, coalesce(new.body_text, new.snippet, ''));
END;
--> statement-breakpoint
CREATE TRIGGER `messages_fts_ad` AFTER DELETE ON `messages` BEGIN
  DELETE FROM `messages_fts` WHERE message_id = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER `messages_fts_au` AFTER UPDATE ON `messages` BEGIN
  DELETE FROM `messages_fts` WHERE message_id = old.id;
  INSERT INTO `messages_fts`(message_id, subject, from_name, from_address, body)
  VALUES (new.id, new.subject, new.from_name, new.from_address, coalesce(new.body_text, new.snippet, ''));
END;
--> statement-breakpoint
-- Backfill any rows that already exist.
INSERT INTO `messages_fts`(message_id, subject, from_name, from_address, body)
SELECT id, subject, from_name, from_address, coalesce(body_text, snippet, '') FROM `messages`;
