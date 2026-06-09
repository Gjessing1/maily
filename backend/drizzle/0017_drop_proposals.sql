-- Remove the Action Center proposals stage (ROADMAP Phase 4 reversal). The Action
-- Center and Trip History features were removed, so the `derived`-stage `proposals`
-- table and its rows go with them. Also purge the dead LLM `summary` enrichment rows:
-- the summary enricher was removed (the general LLM client framework is retained for
-- future use, e.g. regex-search construction — ROADMAP Phase 5). Both are rebuildable
-- projections over messages, so dropping/purging loses no source-of-truth data.
DROP TABLE IF EXISTS `proposals`;--> statement-breakpoint
DELETE FROM `enrichments` WHERE `enricher` = 'summary';
