/**
 * Contacts manager (ROADMAP §3.7.B). A standalone address-book view over the
 * cached CardDAV cards with full write-back: create, edit, and delete cards on the
 * Radicale server. Writes go through the backend, which PUTs/DELETEs the vCard and
 * re-syncs the local cache (Radicale stays authoritative), so the list reflects the
 * server after every change.
 *
 * Cards are grouped by their address book — the default book first, then the other
 * active books, then inactive ones — so every Radicale book is browsable here even
 * though composer autocomplete only draws from the active set. Each book's section
 * can be hidden/unhidden (a synced view preference); hiding never changes which books
 * feed the composer.
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AddressbookDto, ContactCardDto } from '@maily/shared';
import { api, downloadContactsVcf } from '../api/client';
import { setPref, usePrefs } from '../state/prefs';
import { avatarHue, initials } from '../ui/format';
import { ContactEditor } from '../components/ContactEditor';
import { Spinner } from '../ui/Spinner';
import {
  BackIcon,
  ChevronDownIcon,
  CloseIcon,
  DownloadIcon,
  PlusIcon,
  SearchIcon,
  UploadIcon,
} from '../ui/icons';

/**
 * Whole-card match: every whitespace-separated term must appear somewhere in the
 * card's searchable text — name/nickname, company/title, emails, phones, websites,
 * notes, and categories (ROADMAP §C global contact search).
 */
function matchesQuery(c: ContactCardDto, q: string): boolean {
  if (!q) return true;
  const hay = [
    c.name,
    c.nickname,
    c.org,
    c.title,
    c.note,
    ...c.emails,
    ...c.phones.map((p) => p.value),
    ...c.urls.map((u) => u.value),
    ...c.categories,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return q.split(/\s+/).every((t) => hay.includes(t));
}

/** A book to render plus the cards (already query-filtered) that belong to it. */
interface BookGroup {
  href: string | null;
  displayName: string;
  /** null for the synthetic "Other" bucket (legacy/untagged cards). */
  active: boolean;
  isDefault: boolean;
  cards: ContactCardDto[];
}

export function Contacts() {
  const navigate = useNavigate();
  const prefs = usePrefs();
  const [cards, setCards] = useState<ContactCardDto[] | null>(null);
  const [books, setBooks] = useState<AddressbookDto[]>([]);
  const [activeBooks, setActiveBooks] = useState<string[]>([]);
  const [defaultBook, setDefaultBook] = useState<string | null>(null);
  // Free-text search across all card fields (names, emails, phones, notes, company).
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  // When set, the create-contact editor is open (targeting this address book).
  const [creating, setCreating] = useState<{ addressbook: string | null } | null>(null);
  // Transient banner for import/export outcome; null = hidden.
  const [notice, setNotice] = useState<string | null>(null);
  // True while an import/export round-trip is in flight (disables the buttons).
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api
      .contactCards()
      .then(setCards)
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(load, [load]);

  // Address books drive the section grouping + the create target.
  useEffect(() => {
    api
      .addressbooks()
      .then((s) => {
        setBooks(s.books);
        setActiveBooks(s.active);
        setDefaultBook(s.default);
      })
      .catch(() => undefined);
  }, []);

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const hidden = prefs.hiddenContactBooks;
  // New cards land in the configured default book.
  const createTarget = defaultBook;

  // Order books for display: default first, then other active, then inactive. Each
  // book carries its query-filtered cards. A trailing "Other" bucket catches cards
  // whose book isn't known (legacy/untagged rows) so nothing silently disappears.
  const rank = (href: string): number =>
    href === defaultBook ? 0 : activeBooks.includes(href) ? 1 : 2;
  const ordered = [...books].sort(
    (a, b) => rank(a.href) - rank(b.href) || a.displayName.localeCompare(b.displayName),
  );
  const groups: BookGroup[] = ordered.map((b) => ({
    href: b.href,
    displayName: b.displayName,
    active: activeBooks.includes(b.href),
    isDefault: b.href === defaultBook,
    cards: (cards ?? []).filter((c) => c.addressbook === b.href && matchesQuery(c, q)),
  }));
  const known = new Set(books.map((b) => b.href));
  const otherCards = (cards ?? []).filter(
    (c) => (!c.addressbook || !known.has(c.addressbook)) && matchesQuery(c, q),
  );
  if (otherCards.length > 0) {
    groups.push({
      href: null,
      displayName: 'Other',
      active: false,
      isDefault: false,
      cards: otherCards,
    });
  }
  // While searching, surface only books with hits (and force them open). Otherwise
  // show every book so all are browsable, respecting each one's hidden state.
  const sections = searching ? groups.filter((g) => g.cards.length > 0) : groups;
  const totalVisible = groups.reduce((n, g) => n + g.cards.length, 0);

  const toggleHidden = (href: string | null) => {
    if (!href) return; // the "Other" bucket isn't a real book — nothing to persist
    setPref(
      'hiddenContactBooks',
      hidden.includes(href) ? hidden.filter((h) => h !== href) : [...hidden, href],
    );
  };

  // Export every cached book as one `.vcf`.
  const onExport = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await downloadContactsVcf(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Read the chosen `.vcf` and import it into the create-target (default) book.
  const onImportPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so re-picking the same file fires onChange again
    if (!file) return;
    setBusy(true);
    setNotice(null);
    file
      .text()
      .then((text) => api.importContacts(text, createTarget))
      .then((r) => {
        const imported = `Imported ${r.imported} contact${r.imported === 1 ? '' : 's'}`;
        setNotice(
          r.imported === 0
            ? 'No contacts imported.'
            : r.skipped
              ? `${imported}, skipped ${r.skipped}.`
              : `${imported}.`,
        );
        load();
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top sticky top-0 z-10 flex items-center gap-1 border-b border-border bg-bg/85 px-2 py-2 backdrop-blur">
        <button
          onClick={() => navigate(-1)}
          className="rounded-full p-2 active:bg-surface-2"
          aria-label="Back"
        >
          <BackIcon />
        </button>
        <h1 className="flex-1 text-lg font-semibold">Contacts</h1>
        <input
          ref={fileInput}
          type="file"
          accept=".vcf,text/vcard,text/x-vcard"
          onChange={onImportPick}
          className="hidden"
        />
        <button
          onClick={() => fileInput.current?.click()}
          disabled={busy}
          className="rounded-full p-2 active:bg-surface-2 disabled:opacity-40"
          aria-label="Import contacts from vCard"
          title="Import vCard"
        >
          <UploadIcon />
        </button>
        <button
          onClick={onExport}
          disabled={busy || !cards || cards.length === 0}
          className="rounded-full p-2 active:bg-surface-2 disabled:opacity-40"
          aria-label="Export contacts to vCard"
          title="Export vCard"
        >
          <DownloadIcon />
        </button>
        <button
          onClick={() => setCreating({ addressbook: createTarget })}
          className="rounded-full p-2 text-accent active:bg-surface-2"
          aria-label="Add contact"
        >
          <PlusIcon />
        </button>
      </header>

      {notice && (
        <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-4 py-2 text-sm text-fg">
          <span className="flex-1">{notice}</span>
          <button
            onClick={() => setNotice(null)}
            className="shrink-0 text-faint active:text-fg"
            aria-label="Dismiss"
          >
            <CloseIcon className="size-4" />
          </button>
        </div>
      )}

      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
          <SearchIcon className="size-4 shrink-0 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search contacts"
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
            aria-label="Search contacts"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="shrink-0 text-faint active:text-fg"
              aria-label="Clear search"
            >
              <CloseIcon className="size-4" />
            </button>
          )}
        </div>
      </div>

      <main className="flex-1 overflow-y-auto no-scrollbar">
        {error && <p className="px-4 py-3 text-sm text-danger">Couldn’t load contacts: {error}</p>}

        {cards === null && !error ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : cards && cards.length === 0 ? (
          !error && (
            <div className="flex flex-col items-center gap-2 py-20 text-center text-muted">
              <p>No contacts yet.</p>
              <button
                onClick={() => setCreating({ addressbook: createTarget })}
                className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-white"
              >
                Add a contact
              </button>
            </div>
          )
        ) : searching && totalVisible === 0 ? (
          !error && (
            <div className="py-20 text-center text-muted">
              <p>No contacts match “{query.trim()}”.</p>
            </div>
          )
        ) : (
          sections.map((g) => (
            <BookSection
              key={g.href ?? '__other__'}
              group={g}
              collapsed={!searching && g.href !== null && hidden.includes(g.href)}
              onToggle={() => toggleHidden(g.href)}
              onOpen={(uid) => navigate(`/contacts/${encodeURIComponent(uid)}`)}
            />
          ))
        )}
      </main>

      {creating && (
        <ContactEditor
          card={null}
          addressbook={creating.addressbook}
          onClose={() => setCreating(null)}
          onSaved={(uid) => {
            setCreating(null);
            if (uid) navigate(`/contacts/${encodeURIComponent(uid)}`);
            else load();
          }}
        />
      )}
    </div>
  );
}

/** One collapsible address-book section: a header row plus its contact rows. */
function BookSection({
  group,
  collapsed,
  onToggle,
  onOpen,
}: {
  group: BookGroup;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: (uid: string) => void;
}) {
  const togglable = group.href !== null;
  return (
    <section>
      <button
        onClick={togglable ? onToggle : undefined}
        aria-expanded={!collapsed}
        className={`sticky top-0 z-[1] flex w-full items-center gap-2 border-b border-border bg-surface/95 px-3 py-2 text-left backdrop-blur ${
          togglable ? 'active:bg-surface-2' : 'cursor-default'
        }`}
      >
        {togglable && (
          <ChevronDownIcon
            className={`size-4 shrink-0 text-faint transition-transform ${collapsed ? '-rotate-90' : ''}`}
          />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">
          {group.displayName}
        </span>
        {group.isDefault ? (
          <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
            Default
          </span>
        ) : (
          !group.active &&
          group.href !== null && (
            <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-faint">
              Inactive
            </span>
          )
        )}
        <span className="shrink-0 text-xs tabular-nums text-faint">{group.cards.length}</span>
      </button>

      {!collapsed &&
        (group.cards.length === 0 ? (
          <p className="px-4 py-3 text-sm text-faint">No contacts in this book.</p>
        ) : (
          <ul>
            {group.cards.map((c) => {
              const display = c.name || c.emails[0] || '(no name)';
              const hue = avatarHue(c.emails[0] ?? display);
              return (
                <li key={c.uid}>
                  <button
                    onClick={() => onOpen(c.uid)}
                    className="flex w-full items-center gap-3 border-b border-border/60 px-4 py-3 text-left active:bg-surface-2"
                  >
                    {c.photo ? (
                      <img
                        src={c.photo}
                        alt=""
                        className="size-10 shrink-0 rounded-full object-cover"
                      />
                    ) : (
                      <span
                        className="flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
                        style={{ backgroundColor: `hsl(${hue} 45% 42%)` }}
                      >
                        {initials(c.name, c.emails[0] ?? null)}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] text-fg">{display}</span>
                      <span className="block truncate text-sm text-faint">
                        {c.org || c.emails.join(', ')}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ))}
    </section>
  );
}
