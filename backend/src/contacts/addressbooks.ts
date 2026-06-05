/**
 * Address-book registry + active/default settings (ROADMAP §C, contacts Phase 1).
 *
 * Address books are auto-discovered from the CardDAV server (see `./discover.ts`);
 * this module holds the in-memory discovered set plus the user's choices — which
 * books are **active** (synced into the contacts cache and shown) and which is the
 * **default** target for new cards. Choices persist server-side (so the backend can
 * honour them during sync/create), in `app_settings` under a dedicated key, separate
 * from the client-owned `prefs` blob.
 *
 * `active === null` means "never set" → all discovered books are active by default;
 * an explicit array (even empty) is honoured verbatim. Hrefs not currently discovered
 * are filtered out so a stale selection can't reference a removed book.
 */
import type { AddressbookSettingsDto } from '@maily/shared';
import { getSetting, putSetting } from '../db/settings.js';

/** One CardDAV address-book collection. */
export interface Addressbook {
  href: string;
  displayName: string;
}

/** Stored shape: active = null means "all"; default = null means "first active". */
interface StoredSettings {
  active: string[] | null;
  default: string | null;
}

const SETTINGS_KEY = 'contacts.addressbooks';

/** The most recently discovered books — refreshed on each sync / on demand. */
let discovered: Addressbook[] = [];

export function setDiscovered(books: Addressbook[]): void {
  discovered = books;
}

export function getDiscovered(): Addressbook[] {
  return discovered;
}

function read(): StoredSettings {
  const s = getSetting<Partial<StoredSettings>>(SETTINGS_KEY, {});
  return {
    active: Array.isArray(s.active) ? s.active.map(String) : null,
    default: s.default ?? null,
  };
}

/** Hrefs of the books to sync/show: the stored selection, defaulting to all discovered. */
export function effectiveActive(): string[] {
  const all = discovered.map((b) => b.href);
  const s = read();
  if (s.active === null) return all;
  return s.active.filter((h) => all.includes(h));
}

/** The create target: the stored default if still active, else the first active book. */
export function effectiveDefault(): string | null {
  const active = effectiveActive();
  const s = read();
  if (s.default && active.includes(s.default)) return s.default;
  return active[0] ?? null;
}

/** Persist the active/default selection (the next sync applies it to the cache). */
export function setAddressbookSettings(active: string[] | null, def: string | null): void {
  putSetting(SETTINGS_KEY, { active, default: def } satisfies StoredSettings);
}

/** Current state for the API: discovered books + resolved active set + default. */
export function getAddressbookState(): AddressbookSettingsDto {
  return { books: discovered, active: effectiveActive(), default: effectiveDefault() };
}
