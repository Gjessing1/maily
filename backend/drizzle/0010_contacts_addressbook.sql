-- Multiple address books (ROADMAP §C contacts Phase 1). Additive + nullable so the
-- migration is safe on the live DB; both columns are repopulated on the next
-- addressbook sync (the contacts table is a rebuildable cache), so no backfill.

-- contacts.addressbook_href: the CardDAV collection the card lives in (its href).
-- Lets the manager filter/group by book and pick a create target. NULL = pre-sync/legacy.
ALTER TABLE `contacts` ADD `addressbook_href` text;--> statement-breakpoint

-- contacts.addressbook_name: the book's display name at sync time, for labelling
-- without a live discovery round-trip.
ALTER TABLE `contacts` ADD `addressbook_name` text;
