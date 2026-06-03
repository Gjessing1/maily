CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`vcard_uid` text,
	`created_at` integer DEFAULT (unixepoch() * 1000),
	`updated_at` integer DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_email_uq` ON `contacts` (`email`);--> statement-breakpoint
CREATE INDEX `contacts_name_idx` ON `contacts` (`name`);
