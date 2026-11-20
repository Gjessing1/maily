-- Preserve the existing plain-body and header columns. Index visible HTML separately
-- so mail search can use both versions of a body and cleanup can use its existing fields.
DROP TRIGGER `messages_fts_ai`;
--> statement-breakpoint
DROP TRIGGER `messages_fts_ad`;
--> statement-breakpoint
DROP TRIGGER `messages_fts_au`;
--> statement-breakpoint
DROP TABLE `messages_fts`;
--> statement-breakpoint
CREATE VIRTUAL TABLE `messages_fts` USING fts5(
  message_id UNINDEXED,
  subject,
  from_name,
  from_address,
  body,
  html_body,
  tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
-- Restore the existing search fields at migration time. The background backfill
-- converts stored HTML in batches after the service starts accepting requests.
INSERT INTO `messages_fts`(message_id, subject, from_name, from_address, body)
SELECT id, subject, from_name, from_address, coalesce(body_text, snippet, '') FROM `messages`;
--> statement-breakpoint
CREATE TRIGGER `messages_fts_ai` AFTER INSERT ON `messages` BEGIN
  INSERT INTO `messages_fts`(message_id, subject, from_name, from_address, body, html_body)
  VALUES (new.id, new.subject, new.from_name, new.from_address, coalesce(new.body_text, new.snippet, ''),
          mail_html_search_text(new.body_html, new.body_text));
END;
--> statement-breakpoint
CREATE TRIGGER `messages_fts_ad` AFTER DELETE ON `messages` BEGIN
  DELETE FROM `messages_fts` WHERE message_id = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER `messages_fts_au`
AFTER UPDATE OF subject, from_name, from_address, body_text, body_html, snippet ON `messages`
WHEN old.subject IS NOT new.subject
  OR old.from_name IS NOT new.from_name
  OR old.from_address IS NOT new.from_address
  OR old.body_html IS NOT new.body_html
  OR coalesce(old.body_text, old.snippet, '') IS NOT coalesce(new.body_text, new.snippet, '')
BEGIN
  DELETE FROM `messages_fts` WHERE message_id = old.id;
  INSERT INTO `messages_fts`(message_id, subject, from_name, from_address, body, html_body)
  VALUES (new.id, new.subject, new.from_name, new.from_address, coalesce(new.body_text, new.snippet, ''),
          mail_html_search_text(new.body_html, new.body_text));
END;
