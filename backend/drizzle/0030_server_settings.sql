-- The settings the server acts on leave the client-owned prefs blob for their own document.
-- A key a device never set extracts as NULL, and json_patch drops NULL members, so the server's
-- default applies to it.
INSERT INTO `app_settings` (`key`, `value`, `updated_at`)
SELECT 'server.settings',
	json_patch('{}', json_object(
		'cleanupProtectedKeywords', `value` -> '$.cleanupProtectedKeywords',
		'cleanupNewsletterKeywords', `value` -> '$.cleanupNewsletterKeywords',
		'cleanupColdKeepKeywords', `value` -> '$.cleanupColdKeepKeywords',
		'undoSendSeconds', `value` -> '$.undoSendSeconds'
	)),
	unixepoch() * 1000
FROM `app_settings`
WHERE `key` = 'prefs' AND json_valid(`value`);--> statement-breakpoint

UPDATE `app_settings`
SET `value` = json_remove(`value`,
	'$.cleanupProtectedKeywords',
	'$.cleanupNewsletterKeywords',
	'$.cleanupColdKeepKeywords',
	'$.undoSendSeconds'
)
WHERE `key` = 'prefs' AND json_valid(`value`);--> statement-breakpoint

-- Only the server settings feed cleanup slices now. The table-wide triggers from 0029 also fired
-- for the download-budget ledger, which is written for every archived message, and so discarded
-- the cached cleanup aggregates throughout a source sweep.
DROP TRIGGER `cleanup_version_settings_ai`;--> statement-breakpoint
DROP TRIGGER `cleanup_version_settings_ad`;--> statement-breakpoint
DROP TRIGGER `cleanup_version_settings_au`;--> statement-breakpoint

CREATE TRIGGER `cleanup_version_settings_ai` AFTER INSERT ON `app_settings`
WHEN NEW.`key` = 'server.settings' BEGIN
	UPDATE `data_versions` SET `version` = `version` + 1 WHERE `scope` = 'cleanup';
END;--> statement-breakpoint
CREATE TRIGGER `cleanup_version_settings_ad` AFTER DELETE ON `app_settings`
WHEN OLD.`key` = 'server.settings' BEGIN
	UPDATE `data_versions` SET `version` = `version` + 1 WHERE `scope` = 'cleanup';
END;--> statement-breakpoint
CREATE TRIGGER `cleanup_version_settings_au` AFTER UPDATE OF `key`, `value` ON `app_settings`
WHEN NEW.`key` = 'server.settings' OR OLD.`key` = 'server.settings' BEGIN
	UPDATE `data_versions` SET `version` = `version` + 1 WHERE `scope` = 'cleanup';
END;
