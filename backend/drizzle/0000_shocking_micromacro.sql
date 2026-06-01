CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`provider` text NOT NULL,
	`imap_host` text NOT NULL,
	`imap_port` integer DEFAULT 993 NOT NULL,
	`smtp_host` text NOT NULL,
	`smtp_port` integer DEFAULT 465 NOT NULL,
	`last_modseq` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`filename` text,
	`mime_type` text,
	`size_bytes` integer,
	`imap_part_id` text,
	`content_id` text,
	`is_inline` integer DEFAULT false NOT NULL,
	`storage_path` text,
	`downloaded_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachments_message_idx` ON `attachments` (`message_id`);--> statement-breakpoint
CREATE TABLE `folders` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'custom' NOT NULL,
	`uid_validity` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `folders_account_path_uq` ON `folders` (`account_id`,`path`);--> statement-breakpoint
CREATE TABLE `message_folders` (
	`message_id` text NOT NULL,
	`folder_id` text NOT NULL,
	`uid` integer,
	PRIMARY KEY(`message_id`, `folder_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_folders_folder_uid_idx` ON `message_folders` (`folder_id`,`uid`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`message_id` text,
	`gm_msgid` text,
	`thread_id` text,
	`in_reply_to` text,
	`references` text,
	`subject` text,
	`from_name` text,
	`from_address` text,
	`snippet` text,
	`body_text` text,
	`body_html` text,
	`sent_at` integer,
	`received_at` integer,
	`seen` integer DEFAULT false NOT NULL,
	`flagged` integer DEFAULT false NOT NULL,
	`answered` integer DEFAULT false NOT NULL,
	`draft` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_account_idx` ON `messages` (`account_id`);--> statement-breakpoint
CREATE INDEX `messages_message_id_idx` ON `messages` (`message_id`);--> statement-breakpoint
CREATE INDEX `messages_gm_msgid_idx` ON `messages` (`gm_msgid`);--> statement-breakpoint
CREATE INDEX `messages_thread_idx` ON `messages` (`thread_id`);--> statement-breakpoint
CREATE INDEX `messages_received_idx` ON `messages` (`received_at`);