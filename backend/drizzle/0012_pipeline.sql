-- Phase 4 enrichment-pipeline framework (ROADMAP Phase 4; ARCHITECTURE §14/§15).
-- Two new tables in the canonical state model: `enrichments` (the `enriched` stage,
-- which here doubles as the durable work *ledger*) and `proposals` (the `derived`
-- stage consumed later by the Action Center). Both are a rebuildable projection over
-- `messages` — drop and rebuild from parsed/source state with zero IMAP refetch (§15).
-- Additive tables, safe on the live DB (no backfill — the pipeline self-heals by
-- enqueuing pending rows for messages that lack a current-version enrichment).

-- enrichments: one row per (message, enricher). Serves three roles at once —
--   * work queue   : status='pending' + next_attempt_at gate the runner's claim scan;
--   * result store : status='ok' rows carry the enricher output JSON;
--   * dead-letter  : status='dead' is a poison message that exhausted its retries.
-- Observability (duration, failure reason, version applied, queue depth) is all
-- derivable from this single ledger — no separate tables.
CREATE TABLE `enrichments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`enricher` text NOT NULL,
	`enricher_version` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`result` text,
	`error` text,
	`duration_ms` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000),
	`updated_at` integer DEFAULT (unixepoch() * 1000),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- One current row per enricher per message; a re-run replaces it (idempotent reindex).
CREATE UNIQUE INDEX `enrichments_message_enricher_uq` ON `enrichments` (`message_id`,`enricher`);--> statement-breakpoint
-- The runner's hot path: claim due pending work.
CREATE INDEX `enrichments_status_due_idx` ON `enrichments` (`status`,`next_attempt_at`);--> statement-breakpoint
-- Stale detection on an enricher version bump (mark affected rows for re-run).
CREATE INDEX `enrichments_enricher_version_idx` ON `enrichments` (`enricher`,`enricher_version`);--> statement-breakpoint

-- proposals: the `derived` stage — an *offer* attached to a source message (calendar
-- event, package tracking, …). Un-acted proposals silently expire (expires_at) rather
-- than accumulating into a second inbox (ROADMAP Phase 4 anti-chore guardrail). Created
-- now so enrichers can emit into it; the Action Center UI that consumes it lands later.
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`enricher` text NOT NULL,
	`type` text NOT NULL,
	`title` text,
	`payload` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000),
	`resolved_at` integer,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `proposals_status_idx` ON `proposals` (`status`);--> statement-breakpoint
CREATE INDEX `proposals_message_idx` ON `proposals` (`message_id`);
