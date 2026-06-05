-- Rich contact fields (ROADMAP §C contacts Phase 2). Additive + nullable so the
-- migration is safe on the live DB; the column is repopulated on the next addressbook
-- sync (the contacts table is a rebuildable cache), so no backfill is needed.

-- contacts.raw_vcard: the card's full raw vCard text, kept verbatim so rich fields
-- (phone, org, address, birthday, …) can be parsed for display and edits can be merged
-- back without dropping properties maily doesn't model (PHOTO, X-*). NULL = legacy row.
ALTER TABLE `contacts` ADD `raw_vcard` text;
