-- Per-sender / per-domain mail rules (rules/): passive routing for new INBOX mail. A rule matches
-- a sender address exactly, or a domain and its subdomains, and carries independent actions —
-- a move (spam / archive / trash) and the read / star flags. Rules fire only on mail the INBOX
-- sync inserts after `created_at`; older mail is touched only by an explicit apply-to-existing.
-- `account_id` NULL means every account. `hits` / `last_hit_at` are for transparency only.
CREATE TABLE `mail_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`match_kind` text NOT NULL,
	`match_value` text NOT NULL,
	`move` text,
	`mark_read` integer DEFAULT false NOT NULL,
	`star` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`hits` integer DEFAULT 0 NOT NULL,
	`last_hit_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000),
	`updated_at` integer DEFAULT (unixepoch() * 1000),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
-- One rule per (scope, match). IFNULL so two every-account rules for the same match collide too
-- (a plain unique index treats NULLs as distinct).
CREATE UNIQUE INDEX `mail_rules_match_uq` ON `mail_rules` (IFNULL(`account_id`, ''), `match_kind`, `match_value`);
