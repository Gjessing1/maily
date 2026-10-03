-- Covering index for the newest-first list views (queries.ts `listPage`). `received_at` — the
-- sort key — sits AFTER body_text/body_html in each record, so a sort over a large folder walks
-- every body's overflow pages just to read it: the 17k-row Gmail Trash took ~300 ms on the N150
-- (Archived ~80 ms, Starred ~35 ms). The IS NULL visibility tests are cheap (header-only), the
-- sort key is not. This index carries the key plus every column the list predicates read, so
-- the id-selecting inner query never touches the table; only the final page's rows are fetched.
-- The planner will NOT pick it on its own (without sqlite_stat1 it prefers the unique PK index
-- for the `id = ?` join), so the list queries name it with INDEXED BY — never rename it alone.
CREATE INDEX `messages_list_cover_idx` ON `messages` (`id`, `received_at`, `deleted_at`, `purged_at`, `seen`, `account_id`, `flagged`);
