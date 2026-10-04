-- Protect rules (rules/, ROADMAP §4 phase 4): a rule with `protect` set shields every message
-- from its sender / domain from cleanup — the per-message `cleanup_keep` flag, for a whole
-- sender. It is a gate, not an ingest action, so it covers existing mail too.
ALTER TABLE `mail_rules` ADD `protect` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Which mail the cleanup slices may list now depends on protect rules, so a change to one must
-- bump the cleanup data version (migration 0029) or cached slice previews keep showing mail the
-- user just protected. Rules without `protect` never touch cleanup.
CREATE TRIGGER `cleanup_version_rules_ai` AFTER INSERT ON `mail_rules`
WHEN NEW.`protect` = 1 BEGIN
	UPDATE `data_versions` SET `version` = `version` + 1 WHERE `scope` = 'cleanup';
END;--> statement-breakpoint
CREATE TRIGGER `cleanup_version_rules_ad` AFTER DELETE ON `mail_rules`
WHEN OLD.`protect` = 1 BEGIN
	UPDATE `data_versions` SET `version` = `version` + 1 WHERE `scope` = 'cleanup';
END;--> statement-breakpoint
-- Hit counters and the ingest actions are outside the gate.
CREATE TRIGGER `cleanup_version_rules_au` AFTER UPDATE OF
	`account_id`, `match_kind`, `match_value`, `enabled`, `protect`
ON `mail_rules`
WHEN OLD.`protect` = 1 OR NEW.`protect` = 1 BEGIN
	UPDATE `data_versions` SET `version` = `version` + 1 WHERE `scope` = 'cleanup';
END;
