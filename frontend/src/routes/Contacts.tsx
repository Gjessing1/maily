/**
 * Contacts manager (ROADMAP §3.7.B). A standalone address-book view over the
 * cached CardDAV cards with full write-back: create, edit, and delete cards on the
 * Radicale server. Writes go through the backend, which PUTs/DELETEs the vCard and
 * re-syncs the local cache (Radicale stays authoritative), so the list reflects the
 * server after every change.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ContactCardDto } from '@maily/shared';
import { api } from '../api/client';
import { avatarHue, initials } from '../ui/format';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Spinner } from '../ui/Spinner';
import { BackIcon, CloseIcon, PlusIcon, TrashIcon } from '../ui/icons';

/** Editor draft. `card` null = creating a new card; otherwise editing it. */
interface Draft {
  card: ContactCardDto | null;
  name: string;
  emails: string[];
}

function newDraft(card: ContactCardDto | null): Draft {
  return {
    card,
    name: card?.name ?? '',
    // Always leave one empty field to type into when none exist.
    emails: card && card.emails.length > 0 ? [...card.emails] : [''],
  };
}

export function Contacts() {
  const navigate = useNavigate();
  const [cards, setCards] = useState<ContactCardDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  const load = useCallback(() => {
    api
      .contactCards()
      .then(setCards)
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(load, [load]);

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
          onClick={() => setDraft(newDraft(null))}
          className="rounded-full p-2 text-accent active:bg-surface-2"
          aria-label="Add contact"
        >
          <PlusIcon />
        </button>
      </header>

      <main className="flex-1 overflow-y-auto no-scrollbar">
        {error && <p className="px-4 py-3 text-sm text-danger">Couldn’t load contacts: {error}</p>}

        {cards === null && !error ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : cards && cards.length > 0 ? (
          <ul>
            {cards.map((c) => {
              const display = c.name || c.emails[0] || '(no name)';
              const hue = avatarHue(c.emails[0] ?? display);
              return (
                <li key={c.uid}>
                  <button
                    onClick={() => setDraft(newDraft(c))}
                    className="flex w-full items-center gap-3 border-b border-border/60 px-4 py-3 text-left active:bg-surface-2"
                  >
                    <span
                      className="flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
                      style={{ backgroundColor: `hsl(${hue} 45% 42%)` }}
                    >
                      {initials(c.name, c.emails[0] ?? null)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] text-fg">{display}</span>
                      {c.emails.length > 0 && (
                        <span className="block truncate text-sm text-faint">
                          {c.emails.join(', ')}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          !error && (
            <div className="flex flex-col items-center gap-2 py-20 text-center text-muted">
              <p>No contacts yet.</p>
              <button
                onClick={() => setDraft(newDraft(null))}
                className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-white"
              >
                Add a contact
              </button>
            </div>
          )
        )}
      </main>

      {draft && (
        <ContactEditor
          draft={draft}
          onClose={() => setDraft(null)}
          onSaved={() => {
            setDraft(null);
            load();
          }}
        />
      )}
    </div>
  );
}

/** Modal create/edit form for a single card. */
function ContactEditor({
  draft,
  onClose,
  onSaved,
}: {
  draft: Draft;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(draft.name);
  const [emails, setEmails] = useState<string[]>(draft.emails);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const editing = draft.card !== null;

  const setEmail = (i: number, v: string) =>
    setEmails((prev) => prev.map((e, idx) => (idx === i ? v : e)));
  const addEmail = () => setEmails((prev) => [...prev, '']);
  const removeEmail = (i: number) =>
    setEmails((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));

  async function save() {
    const cleaned = emails.map((e) => e.trim()).filter(Boolean);
    if (cleaned.length === 0) {
      setError('Add at least one email address.');
      return;
    }
    setBusy(true);
    setError(null);
    const input = { name: name.trim() || null, emails: cleaned };
    try {
      if (draft.card) await api.updateContactCard(draft.card.uid, input);
      else await api.createContactCard(input);
      onSaved();
    } catch (e) {
      setError((e as Error).message || 'Save failed.');
      setBusy(false);
    }
  }

  async function remove() {
    if (!draft.card) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteContactCard(draft.card.uid);
      onSaved();
    } catch (e) {
      setError((e as Error).message || 'Delete failed.');
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        aria-label="Cancel"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />
      <div className="safe-bottom relative w-full max-w-md rounded-t-2xl border border-border bg-bg p-5 shadow-xl sm:rounded-2xl">
        <h2 className="text-base font-semibold text-fg">
          {editing ? 'Edit contact' : 'New contact'}
        </h2>

        <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-faint">
          Name
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Full name"
          className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-[15px] text-fg outline-none focus:border-accent"
        />

        <p className="mt-4 text-xs font-medium uppercase tracking-wide text-faint">Emails</p>
        <div className="mt-1 flex flex-col gap-2">
          {emails.map((e, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                value={e}
                onChange={(ev) => setEmail(i, ev.target.value)}
                placeholder="name@example.com"
                type="email"
                inputMode="email"
                className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-[15px] text-fg outline-none focus:border-accent"
              />
              {emails.length > 1 && (
                <button
                  onClick={() => removeEmail(i)}
                  className="shrink-0 rounded-full p-2 text-faint active:bg-surface-2"
                  aria-label="Remove email"
                >
                  <CloseIcon className="size-4" />
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          onClick={addEmail}
          className="mt-2 flex items-center gap-1.5 text-sm text-accent active:opacity-70"
        >
          <PlusIcon className="size-4" /> Add email
        </button>

        {error && <p className="mt-3 text-sm text-danger">{error}</p>}

        <div className="mt-5 flex items-center gap-2">
          {editing && (
            <button
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
              className="rounded-full p-2 text-danger active:bg-surface-2 disabled:opacity-50"
              aria-label="Delete contact"
            >
              <TrashIcon className="size-5" />
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button
              onClick={onClose}
              disabled={busy}
              className="rounded-full px-4 py-2 text-sm text-fg active:bg-surface-2 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={busy}
              className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete contact?"
        message="This removes the card from your addressbook on the server."
        confirmLabel="Delete"
        danger
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
