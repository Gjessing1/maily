-- Server-owned outbox: a DB-backed, restart-safe, cancelable deferred-action queue for
-- send (undo-send + scheduled "send later"), delete, and archive. Modelled on the
-- `cleanup_queue` pattern (status + next_attempt_at gate the runner's claim scan), with two
-- additions that make a user-facing UNDO window correct:
--   * `due_at` — when the action is allowed to execute (now+undoWindow for undo, a future
--     time for a scheduled send). The runner only claims rows whose window has elapsed.
--   * a transient `sending` status — the runner atomically flips pending->sending before
--     acting, so a concurrent cancel (pending->canceled) and the runner can't both win.
-- `payload` carries the SendMessageRequest JSON for sends; `message_id` is the target for
-- delete/archive. Additive table, safe on the live DB (no backfill).
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`message_id` text,
	`payload` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`due_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000),
	`updated_at` integer DEFAULT (unixepoch() * 1000),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- The runner's hot path: claim due pending work (status + due_at), oldest first.
CREATE INDEX `outbox_status_due_idx` ON `outbox` (`status`,`due_at`);--> statement-breakpoint
-- Resolve a message's pending action (undo of delete/archive looks up by message).
CREATE INDEX `outbox_message_idx` ON `outbox` (`message_id`);
