/**
 * Contacts manager (ROADMAP §3.7.B). A standalone address-book view over the
 * cached CardDAV cards with full write-back: create, edit, and delete cards on the
 * Radicale server. Writes go through the backend, which PUTs/DELETEs the vCard and
 * re-syncs the local cache (Radicale stays authoritative), so the list reflects the
 * server after every change.
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AddressbookDto, ContactCardDto } from '@maily/shared';
import { api, downloadContactsVcf } from '../api/client';
import { avatarHue, initials } from '../ui/format';
import { ContactEditor } from '../components/ContactEditor';
import { Spinner } from '../ui/Spinner';
import { BackIcon, CloseIcon, DownloadIcon, PlusIcon, SearchIcon, UploadIcon } from '../ui/icons';

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

export function Contacts() {
  const navigate = useNavigate();
  const [cards, setCards] = useState<ContactCardDto[] | null>(null);
  const [books, setBooks] = useState<AddressbookDto[]>([]);
  const [activeBooks, setActiveBooks] = useState<string[]>([]);
  const [defaultBook, setDefaultBook] = useState<string | null>(null);
  // Selected book filter: null = "All".
  const [filter, setFilter] = useState<string | null>(null);
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

  // Address books drive the filter chips + the create target.
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

  // Only books that are active *and* hold at least one cached card are worth a chip.
  const filterBooks = books.filter((b) => activeBooks.includes(b.href));
  const showFilter = filterBooks.length > 1;
  const q = query.trim().toLowerCase();
  const visible = cards
    ? cards.filter((c) => (!filter || c.addressbook === filter) && matchesQuery(c, q))
    : cards;
  // New cards land in the filtered book if one is picked, else the configured default.
  const createTarget = filter ?? defaultBook;
  const bookName = (href: string | null) => books.find((b) => b.href === href)?.displayName ?? null;

  // Export the current view (the picked book, or every book under "All").
  const onExport = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await downloadContactsVcf(filter);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Read the chosen `.vcf` and import it into the create-target book.
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

      {showFilter && (
        <div className="flex gap-1.5 overflow-x-auto border-b border-border px-3 py-2 no-scrollbar">
          <FilterChip label="All" active={filter === null} onClick={() => setFilter(null)} />
          {filterBooks.map((b) => (
            <FilterChip
              key={b.href}
              label={b.displayName}
              active={filter === b.href}
              onClick={() => setFilter(b.href)}
            />
          ))}
        </div>
      )}

      <main className="flex-1 overflow-y-auto no-scrollbar">
        {error && <p className="px-4 py-3 text-sm text-danger">Couldn’t load contacts: {error}</p>}

        {cards === null && !error ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : visible && visible.length > 0 ? (
          <ul>
            {visible.map((c) => {
              const display = c.name || c.emails[0] || '(no name)';
              const hue = avatarHue(c.emails[0] ?? display);
              return (
                <li key={c.uid}>
                  <button
                    onClick={() => navigate(`/contacts/${encodeURIComponent(c.uid)}`)}
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
        ) : (
          !error && (
            <div className="flex flex-col items-center gap-2 py-20 text-center text-muted">
              {q ? (
                <p>No contacts match “{query.trim()}”.</p>
              ) : (
                <>
                  <p>
                    {filter
                      ? `No contacts in ${bookName(filter) ?? 'this book'}.`
                      : 'No contacts yet.'}
                  </p>
                  <button
                    onClick={() => setCreating({ addressbook: createTarget })}
                    className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-white"
                  >
                    Add a contact
                  </button>
                </>
              )}
            </div>
          )
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

/** A pill that filters the contact list to one address book (or "All"). */
function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`shrink-0 rounded-full px-3 py-1.5 text-sm transition-colors ${
        active ? 'bg-accent text-white' : 'bg-surface-2 text-faint active:bg-surface-3'
      }`}
    >
      {label}
    </button>
  );
}
