-- The cleanup protected gate also counts invoice-enricher facts (a classified invoice or
-- receipt is never offered for deletion), so an invoice enrichment write changes which mail a
-- slice may list. Without these, a cached slice preview kept showing a bill the enricher had
-- just classified until some unrelated mail change bumped the version. Scoped by enricher name
-- only — not by the result's JSON shape — so a change to the invoice output cannot silently
-- slip past; other enrichers (summaries, parcels, …) never touch cleanup.
CREATE TRIGGER `cleanup_version_enrichments_ai` AFTER INSERT ON `enrichments`
WHEN NEW.`enricher` = 'invoice' BEGIN
	UPDATE `data_versions` SET `version` = `version` + 1 WHERE `scope` = 'cleanup';
END;--> statement-breakpoint
CREATE TRIGGER `cleanup_version_enrichments_ad` AFTER DELETE ON `enrichments`
WHEN OLD.`enricher` = 'invoice' BEGIN
	UPDATE `data_versions` SET `version` = `version` + 1 WHERE `scope` = 'cleanup';
END;--> statement-breakpoint
-- Attempt counters, backoff, errors and timings are outside the gate.
CREATE TRIGGER `cleanup_version_enrichments_au` AFTER UPDATE OF
	`message_id`, `enricher`, `enricher_version`, `status`, `result`
ON `enrichments`
WHEN OLD.`enricher` = 'invoice' OR NEW.`enricher` = 'invoice' BEGIN
	UPDATE `data_versions` SET `version` = `version` + 1 WHERE `scope` = 'cleanup';
END;
