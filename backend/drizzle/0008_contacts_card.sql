-- Contact card identity for CardDAV write-back (ROADMAP §3.7.B).
-- Both columns are additive + nullable so the migration is safe on the live DB;
-- they are repopulated on the next addressbook sync, so no backfill is needed.

-- contacts.href: the card's CardDAV resource path (relative to the server origin),
-- captured per <response> in the addressbook REPORT. Needed to PUT/DELETE the exact
-- card on edit/delete. Repeated across a multi-email card's rows. NULL = pre-sync.
ALTER TABLE `contacts` ADD `href` text;--> statement-breakpoint

-- contacts.etag: the card's getetag from the same REPORT. Sent as If-Match on update
-- so a concurrent edit on the server is detected (412) rather than silently clobbered.
ALTER TABLE `contacts` ADD `etag` text;
