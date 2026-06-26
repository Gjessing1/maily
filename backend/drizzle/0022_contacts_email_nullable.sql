-- Make contacts.email nullable so address-book cards with no EMAIL property are still
-- cached and shown in the Contacts manager (previously such cards produced zero rows and
-- were invisible). SQLite can't drop a column's NOT NULL in place, but `contacts` is a
-- rebuildable cache — the next addressbook sync repopulates it — so we just recreate the
-- table. The unique index on email still holds: SQLite treats NULLs as distinct, so many
-- email-less cards coexist without colliding.
DROP TABLE `contacts`;
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text,
	`name` text,
	`vcard_uid` text,
	`href` text,
	`etag` text,
	`addressbook_href` text,
	`addressbook_name` text,
	`raw_vcard` text,
	`created_at` integer DEFAULT (unixepoch() * 1000),
	`updated_at` integer DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_email_uq` ON `contacts` (`email`);--> statement-breakpoint
CREATE INDEX `contacts_name_idx` ON `contacts` (`name`);
