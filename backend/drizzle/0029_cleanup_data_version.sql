-- Cleanup aggregates are memoised, but their validity is a property of the rows they
-- summarize rather than of in-process mail signals. These triggers run on every SQLite
-- connection, including the sync worker's connection.
CREATE TABLE `data_versions` (
	`scope` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL DEFAULT 0
);--> statement-breakpoint
INSERT INTO `data_versions` (`scope`, `version`) VALUES ('cleanup', 0);--> statement-breakpoint

CREATE TRIGGER `cleanup_version_messages_ai` AFTER INSERT ON `messages` BEGIN
	UPDATE `data_versions` SET `version` = `version` + 1 WHERE `scope` = 'cleanup';
END;--> statement-breakpoint
CREATE TRIGGER `cleanup_version_messages_ad` AFTER DELETE ON `messages` BEGIN
	UPDATE `data_versions` SET `version` = `version` + 1 WHERE `scope` = 'cleanup';
END;--> statement-breakpoint
-- Deliberately excludes flags, recipient/thread metadata, and source_path. None affect a
-- cleanup slice. source_bytes remains included because it is the authoritative size once set.
CREATE TRIGGER `cleanup_version_messages_au` AFTER UPDATE OF
	`account_id`, `subject`, `from_name`, `from_address`, `snippet`, `body_text`, `body_html`,
	`source_bytes`, `content_bytes`, `received_at`, `deleted_at`, `cleanup_keep`, `purged_at`
ON `messages` BEGIN
	UPDATE `data_versions` SET `version` = `version` + 1 WHERE `scope` = 'cleanup';
END;--> statement-breakpoint

CREATE TRIGGER `cleanup_version_attachments_ai` AFTER INSERT ON `attachments` BEGIN
	UPDATE `data_versions` SET `version` = `version` + 1 WHERE `scope` = 'cleanup';
END;--> statement-breakpoint
CREATE TRIGGER `cleanup_version_attachments_ad` AFTER DELETE ON `attachments` BEGIN
	UPDATE `data_versions` SET `version` = `version` + 1 WHERE `scope` = 'cleanup';
END;--> statement-breakpoint
CREATE TRIGGER `cleanup_version_attachments_au` AFTER UPDATE OF `message_id`, `size_bytes`
ON `attachments` BEGIN
	UPDATE `data_versions` SET `version` = `version` + 1 WHERE `scope` = 'cleanup';
END;--> statement-breakpoint

-- The summary includes the durable "freed so far" cleanup-queue tally.
CREATE TRIGGER `cleanup_version_queue_ai` AFTER INSERT ON `cleanup_queue` BEGIN
	UPDATE `data_versions` SET `version` = `version` + 1 WHERE `scope` = 'cleanup';
END;--> statement-breakpoint
CREATE TRIGGER `cleanup_version_queue_ad` AFTER DELETE ON `cleanup_queue` BEGIN
	UPDATE `data_versions` SET `version` = `version` + 1 WHERE `scope` = 'cleanup';
END;--> statement-breakpoint
CREATE TRIGGER `cleanup_version_queue_au` AFTER UPDATE OF `message_id`, `status`
ON `cleanup_queue` BEGIN
	UPDATE `data_versions` SET `version` = `version` + 1 WHERE `scope` = 'cleanup';
END;--> statement-breakpoint

-- Cleanup keyword configuration currently lives in app_settings. Invalidating for the rare
-- unrelated setting write is cheap and keeps this trigger independent of JSON blob structure.
CREATE TRIGGER `cleanup_version_settings_ai` AFTER INSERT ON `app_settings` BEGIN
	UPDATE `data_versions` SET `version` = `version` + 1 WHERE `scope` = 'cleanup';
END;--> statement-breakpoint
CREATE TRIGGER `cleanup_version_settings_ad` AFTER DELETE ON `app_settings` BEGIN
	UPDATE `data_versions` SET `version` = `version` + 1 WHERE `scope` = 'cleanup';
END;--> statement-breakpoint
CREATE TRIGGER `cleanup_version_settings_au` AFTER UPDATE OF `key`, `value`
ON `app_settings` BEGIN
	UPDATE `data_versions` SET `version` = `version` + 1 WHERE `scope` = 'cleanup';
END;
