-- messages.local_only / detached_at: "detach to local" (delete from the provider, keep
-- the full copy on this server). When a message is detached its server copy is moved to
-- the provider Trash and `local_only` is set to 1; from then on the row is INERT to IMAP
-- reconciliation (sync never adds/removes/tombstones its folder mappings — see store.ts
-- unlinkUids/clearFolderUids/linkFolder), so it keeps showing in whatever folder it was
-- in (e.g. inbox), served from the local `.eml`. `detached_at` records when (audit).
-- Additive, safe on the live DB (no backfill). No index: low-selectivity flag scanned
-- inside the detach job's per-account candidate walk and skipped in sync's existing scans.
ALTER TABLE `messages` ADD `local_only` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `messages` ADD `detached_at` integer;
