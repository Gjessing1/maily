-- Phase 5 LLM-enrichment scheduling (ROADMAP Phase 5; the Intel N150 guard).
-- Adds a `cost` dimension to the enrichment ledger so the runner can schedule slow
-- Ollama work separately from the cheap deterministic enrichers: cheap rows drain to
-- completion every nudge, LLM rows trickle in small bounded batches. Without this a
-- deep LLM backlog (e.g. summarising the historical mailbox) would sit at the front of
-- the createdAt-ordered claim window and starve cheap enrichment of freshly synced mail.
-- Additive + backfilled by DEFAULT: every existing row is deterministic, hence 'cheap'.
ALTER TABLE `enrichments` ADD `cost` text DEFAULT 'cheap' NOT NULL;--> statement-breakpoint
-- Cost-scoped claim scan: `WHERE cost = ? AND status IN (...) AND next_attempt_at <= ?`.
CREATE INDEX `enrichments_cost_status_due_idx` ON `enrichments` (`cost`,`status`,`next_attempt_at`);
