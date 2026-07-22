-- Only re-index FTS when the indexed content actually changed.
--
-- `messages_fts` stores `message_id UNINDEXED`, so the trigger's
-- `DELETE FROM messages_fts WHERE message_id = old.id` is a linear scan of the whole
-- index — ~74ms per row at 25k messages. The unguarded AFTER UPDATE trigger paid that
-- (plus a full re-tokenize of the body) on *every* column update: marking a message
-- read, flagging it, setting cleanup_keep, rewriting a snippet. None of those change
-- what is indexed.
--
-- The WHEN clause below restricts the trigger to updates that really do change an
-- indexed value. Note `snippet` only reaches the index through
-- `coalesce(body_text, snippet, '')`, so a snippet rewrite re-indexes only when the
-- message has no body_text — which is exactly when the snippet *is* the indexed body.
-- `IS NOT` (not `<>`) so NULL transitions compare correctly.
DROP TRIGGER `messages_fts_au`;
--> statement-breakpoint
CREATE TRIGGER `messages_fts_au` AFTER UPDATE ON `messages`
WHEN old.subject IS NOT new.subject
  OR old.from_name IS NOT new.from_name
  OR old.from_address IS NOT new.from_address
  OR coalesce(old.body_text, old.snippet, '') IS NOT coalesce(new.body_text, new.snippet, '')
BEGIN
  DELETE FROM `messages_fts` WHERE message_id = old.id;
  INSERT INTO `messages_fts`(message_id, subject, from_name, from_address, body)
  VALUES (new.id, new.subject, new.from_name, new.from_address, coalesce(new.body_text, new.snippet, ''));
END;
