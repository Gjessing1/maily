-- Phase 6b cleanup execution path (ROADMAP Phase 6 "Master archive & Cleanup Dashboard").
-- A DB-backed, restart-safe trash queue — one row per message awaiting a rate-limited
-- MOVE-to-Trash, modelled on the `enrichments`-as-queue pattern (status + next_attempt_at
-- gate the runner's claim scan). Trash-only by design: the queue MOVEs to the account's
-- Trash folder and never EXPUNGEs — moving to Trash *is* the archive-before-delete staging
-- (nothing hard-deleted in one step; the provider's Trash keeps a recovery window).
-- Additive table, safe on the live DB (no backfill).
CREATE TABLE `cleanup_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`account_id` text NOT NULL,
	`slice` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000),
	`updated_at` integer DEFAULT (unixepoch() * 1000),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- One queue row per message; re-queuing an already-queued message is a no-op (INSERT OR IGNORE).
CREATE UNIQUE INDEX `cleanup_queue_message_uq` ON `cleanup_queue` (`message_id`);--> statement-breakpoint
-- The runner's hot path: claim due pending work.
CREATE INDEX `cleanup_queue_status_due_idx` ON `cleanup_queue` (`status`,`next_attempt_at`);
