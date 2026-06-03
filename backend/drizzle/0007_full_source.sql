-- Full-source as canonical content store (ROADMAP §3.7.E).
-- All three columns are additive + nullable so the migration is safe on the live
-- DB; null carries its natural "not yet" meaning, so no backfill is needed.

-- messages.source_path: on-disk path of the complete raw RFC822 (.eml) for this
-- message. NULL = not yet archived (the parsed row is still its only copy).
ALTER TABLE `messages` ADD `source_path` text;--> statement-breakpoint

-- attachments.part_ordinal: stable document-order index assigned during the
-- BODYSTRUCTURE walk (extractStructure). Lets the local-source extractor select the
-- matching MIME part by walking the .eml in the same DFS order — collision-free
-- regardless of duplicate filenames/sizes or null filenames.
ALTER TABLE `attachments` ADD `part_ordinal` integer;--> statement-breakpoint

-- folders.oldest_synced_uid: low-watermark of the resumable full-source sweep. The
-- sweep walks downward from here; persisting it means a sweep interrupted by
-- restart/disconnect resumes instead of restarting. NULL = sweep not yet started.
ALTER TABLE `folders` ADD `oldest_synced_uid` integer;
