-- Key the contacts cache per CARD+address instead of per address (ROADMAP §A2, duplicate
-- detection). `contacts_email_uq` made one address collapse to one row globally, so two cards
-- carrying the same address -- the ordinary shape of a cross-address-book duplicate -- were
-- silently deduped at write time by `replaceContacts` and the second card became invisible.
-- Duplicate detection cannot flag what the cache never stored, so the row key moves to
-- (href, email): the card's CardDAV resource path plus the address. Autocomplete keeps its
-- one-suggestion-per-address behaviour by deduping on READ (`searchContacts`) instead.
--
-- No data migration: `contacts` is a rebuildable mirror of Radicale and the next sync replaces
-- it wholesale, so the existing (already-deduped) rows stay valid under the wider index until
-- then -- which is better than emptying the address book for the gap.
DROP INDEX IF EXISTS `contacts_email_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_card_email_uq` ON `contacts` (`href`,`email`);
