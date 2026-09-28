-- A delete of detached (local_only) mail used to tombstone the row and finish its outbox intent
-- without relinking it into Trash: there is no server copy to MOVE, and the executor treated
-- "no MOVE" as "nothing to do". The message stayed mapped to its old folder — hidden there by the
-- tombstone, and absent from Trash because it had no trash mapping — so it showed up nowhere and
-- could not be restored. Give each such completed delete the local move it should have had: its
-- account's trash folder as the single mapping, exactly what the runner now does.
CREATE TEMP TABLE `_stranded_deletes` AS
SELECT m.`id` AS `message_id`,
       (SELECT f.`id` FROM `folders` f
         WHERE f.`account_id` = m.`account_id` AND f.`role` = 'trash' LIMIT 1) AS `trash_id`
FROM `messages` m
WHERE m.`local_only` = 1
  AND m.`deleted_at` IS NOT NULL
  AND m.`purged_at` IS NULL
  AND EXISTS (SELECT 1 FROM `outbox` o
               WHERE o.`message_id` = m.`id` AND o.`kind` = 'delete' AND o.`status` = 'done')
  AND NOT EXISTS (SELECT 1 FROM `message_folders` mf JOIN `folders` f ON f.`id` = mf.`folder_id`
                   WHERE mf.`message_id` = m.`id` AND f.`role` = 'trash');--> statement-breakpoint
DELETE FROM `_stranded_deletes` WHERE `trash_id` IS NULL;--> statement-breakpoint
DELETE FROM `message_folders` WHERE `message_id` IN (SELECT `message_id` FROM `_stranded_deletes`);--> statement-breakpoint
INSERT INTO `message_folders` (`message_id`, `folder_id`, `uid`)
SELECT `message_id`, `trash_id`, NULL FROM `_stranded_deletes`;--> statement-breakpoint
DROP TABLE `_stranded_deletes`;
