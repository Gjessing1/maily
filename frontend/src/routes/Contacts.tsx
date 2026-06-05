/**
 * Contacts manager (ROADMAP §3.7.B). A standalone address-book view over the
 * cached CardDAV cards with full write-back: create, edit, and delete cards on the
 * Radicale server. Writes go through the backend, which PUTs/DELETEs the vCard and
 * re-syncs the local cache (Radicale stays authoritative), so the list reflects the
 * server after every change.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AddressbookDto, ContactCardDto } from '@maily/shared';
import { api } from '../api/client';
import { avatarHue, initials } from '../ui/format';
import { ContactEditor } from '../components/ContactEditor';
import { Spinner } from '../ui/Spinner';
import { BackIcon, PlusIcon } from '../ui/icons';

export function Contacts() {
  const navigate = useNavigate();
  const [cards, setCards] = useState<ContactCardDto[] | null>(null);
  const [books, setBooks] = useState<AddressbookDto[]>([]);
  const [activeBooks, setActiveBooks] = useState<string[]>([]);
  const [defaultBook, setDefaultBook] = useState<string | null>(null);
  // Selected book filter: null = "All".
  const [filter, setFilter] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // When set, the create-contact editor is open (targeting this address book).
  const [creating, setCreating] = useState<{ addressbook: string | null } | null>(null);

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
  const visible = cards && filter ? cards.filter((c) => c.addressbook === filter) : cards;
  // New cards land in the filtered book if one is picked, else the configured default.
  const createTarget = filter ?? defaultBook;
  const bookName = (href: string | null) => books.find((b) => b.href === href)?.displayName ?? null;

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
        <button
          onClick={() => setCreating({ addressbook: createTarget })}
          className="rounded-full p-2 text-accent active:bg-surface-2"
          aria-label="Add contact"
        >
          <PlusIcon />
        </button>
      </header>

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
              <p>
                {filter ? `No contacts in ${bookName(filter) ?? 'this book'}.` : 'No contacts yet.'}
              </p>
              <button
                onClick={() => setCreating({ addressbook: createTarget })}
                className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-white"
              >
                Add a contact
              </button>
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
