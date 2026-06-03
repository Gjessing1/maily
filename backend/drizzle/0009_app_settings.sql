-- Single-user app settings (ROADMAP §B): server-side store for UI preferences so
-- they sync across devices instead of living only in each browser's localStorage.
-- Key-value with a JSON blob; the whole prefs object is stored under key 'prefs'.
-- Additive table, safe on the live DB (no backfill — clients seed it on first save).
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000)
);
