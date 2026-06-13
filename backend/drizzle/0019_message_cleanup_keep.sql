-- messages.cleanup_keep: user-set "preserve from cleanup" flag. 1 ⇒ the message is
-- excluded from every delete-eligible cleanup slice (never-replied / cold-storage /
-- large / unread / newsletters) — a per-message counterpart of the keyword safety
-- gate for mail the heuristics can't recognise as valuable. Cleanup-only: normal
-- folder views and search are unaffected. No index: the flag is a low-selectivity
-- AND inside slice scans that already walk the candidate set.
ALTER TABLE `messages` ADD `cleanup_keep` integer NOT NULL DEFAULT 0;
