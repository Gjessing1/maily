/**
 * Recipient field with CardDAV contacts (ROADMAP §3.7.D). Captured addresses render
 * as removable **chips** so it's obvious what's been committed, and the in-progress
 * token after the last separator stays editable in the trailing input. Focusing the
 * field opens a picker listing the whole addressbook (filtered as you type); picking a
 * contact keeps the list open so several can be added in a row.
 *
 * The public contract is unchanged: `value` is the canonical comma/semicolon-separated
 * address string the composer parses on send, and everything here is derived from it —
 * no separate source of truth, so draft-restore and dirty-detection keep working.
 *
 * Opening rules: the picker does **not** spring open merely on focus. It opens when the
 * user starts typing (server-side search once ≥2 chars) or when they tap the address-book
 * button, which browses the whole addressbook (filterable client-side as you type).
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { ContactDto } from '@maily/shared';
import { api } from '../api/client';
import { ContactEditor } from './ContactEditor';
import { CheckIcon, PlusIcon, UsersIcon } from '../ui/icons';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
}

/** Split a string into trimmed, non-empty address tokens. */
function parseTokens(s: string): string[] {
  return s
    .split(/[,;]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** The committed prefix (up to and including the last separator) and trailing token. */
function splitTrailing(value: string): { prefix: string; token: string } {
  const idx = Math.max(value.lastIndexOf(','), value.lastIndexOf(';'));
  return idx < 0
    ? { prefix: '', token: value }
    : { prefix: value.slice(0, idx + 1), token: value.slice(idx + 1) };
}

/** Bare address out of a `Name <email>` token (for dedupe + validation). */
function addrEmail(token: string): string {
  const m = /<([^>]+)>/.exec(token);
  return (m?.[1] ?? token).trim();
}

/** Pragmatic address shape check — catches typos, not full RFC 5322 validation. */
function isValidEmail(token: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addrEmail(token));
}

/** Short label for a chip: the display name when present, else the address. */
function chipLabel(token: string): string {
  const m = /^(.*?)<([^>]+)>/.exec(token);
  const name = m?.[1]?.trim();
  if (name) return name;
  return m?.[2]?.trim() ?? token;
}

/** Format a chosen contact as a recipient token (display name when present). */
function formatRecipient(c: ContactDto): string {
  return c.name ? `${c.name} <${c.email}>` : c.email;
}

export function RecipientInput({ value, onChange, placeholder, autoFocus, ariaLabel }: Props) {
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  // True when the picker was opened by the address-book button (browse the whole book)
  // rather than by typing; keeps the list up even when the in-progress token is empty.
  const [browse, setBrowse] = useState(false);
  const [active, setActive] = useState(0);
  const [suggestions, setSuggestions] = useState<ContactDto[]>([]);
  // The whole addressbook, lazy-loaded once the picker first opens; shown when the
  // in-progress token is too short to search (so a blank field still lists contacts).
  const [allContacts, setAllContacts] = useState<ContactDto[] | null>(null);
  // When set, the quick-create contact editor is open, seeded with this email.
  const [creatingEmail, setCreatingEmail] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  // Suppress the search that would otherwise fire right after a pick clears the token.
  const skipNextLookup = useRef(false);

  const { prefix, token } = splitTrailing(value);
  const draft = token.replace(/^\s+/, '');
  const committed = parseTokens(prefix);
  // While the field is blurred, a complete trailing address shows as a chip rather than
  // loose text — so a single prefilled/typed recipient still reads as "captured".
  const trailingIsChip = !focused && draft !== '' && isValidEmail(draft);
  const chips = trailingIsChip ? [...committed, draft] : committed;
  const inputText = trailingIsChip ? '' : draft;
  const query = draft.trim();

  // Lazy-load the full addressbook the first time the picker opens.
  useEffect(() => {
    if (!open || allContacts !== null) return;
    let alive = true;
    api
      .contactCards()
      .then((cards) => {
        if (!alive) return;
        setAllContacts(cards.flatMap((c) => c.emails.map((email) => ({ name: c.name, email }))));
      })
      .catch(() => alive && setAllContacts([]));
    return () => {
      alive = false;
    };
  }, [open, allContacts]);

  // Server-side search once the token is long enough; shorter tokens fall back to the
  // full list (handled in `list` below), so there's nothing to fetch for them.
  useEffect(() => {
    if (skipNextLookup.current) {
      skipNextLookup.current = false;
      return;
    }
    if (query.length < 2) {
      setSuggestions([]);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      api
        .contacts(query)
        .then((rows) => {
          if (!alive) return;
          setSuggestions(rows);
          setActive(0);
        })
        .catch(() => undefined);
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query]);

  // What the dropdown shows: server search hits once ≥2 chars are typed; otherwise the
  // whole book (client-filtered) but only while browsing — typing nothing outside browse
  // mode shows nothing. Either way, drop anything already added as a chip.
  const added = new Set(chips.map((c) => addrEmail(c).toLowerCase()));
  const q = query.toLowerCase();
  let source: ContactDto[];
  if (query.length >= 2) {
    source = suggestions;
  } else if (browse) {
    source = (allContacts ?? []).filter(
      (c) =>
        !q || (c.name?.toLowerCase().includes(q) ?? false) || c.email.toLowerCase().includes(q),
    );
  } else {
    source = [];
  }
  // Browse mode is a multi-select: already-added contacts stay in the list with a
  // check so they can be toggled back off. Typeahead search still hides added hits
  // (you're narrowing toward one new address, not curating a set).
  const list = browse ? source : source.filter((c) => !added.has(c.email.toLowerCase()));
  const activeIdx = active < list.length ? active : 0;

  // Offer "create contact" when the typed token is a valid address that isn't already
  // a known contact (quick-create from compose). The bare email seeds the editor.
  const draftEmail = addrEmail(draft).toLowerCase();
  const showCreate =
    isValidEmail(draft) &&
    !added.has(draftEmail) &&
    !list.some((c) => c.email.toLowerCase() === draftEmail) &&
    !(allContacts ?? []).some((c) => c.email.toLowerCase() === draftEmail);

  /** Rebuild the value from the committed chips plus a trailing in-progress token. */
  function emit(chipTokens: string[], tail: string) {
    const lead = chipTokens.length ? `${chipTokens.join(', ')}, ` : '';
    onChange(lead + tail);
  }

  /** Replace the in-progress token as the user types; open the picker once typing starts. */
  function setInput(text: string) {
    emit(committed, text);
    if (text.trim()) setOpen(true);
    else if (!browse) setOpen(false);
  }

  /** Address-book button: toggle the full-addressbook browse picker. */
  function toggleBrowse() {
    if (open) {
      setOpen(false);
      setBrowse(false);
    } else {
      setBrowse(true);
      setOpen(true);
      setActive(0);
    }
    inputRef.current?.focus();
  }

  /** Turn the typed token into a chip (on Enter / comma / blur). */
  function commitDraft() {
    const t = draft.trim();
    if (!t) return;
    emit([...committed, t], '');
  }

  /**
   * Toggle a picked contact (multi-select): add it as a chip, or remove it if already
   * present. The partial token is discarded on add; the list stays open either way.
   */
  function toggleContact(c: ContactDto) {
    const email = c.email.toLowerCase();
    if (added.has(email)) {
      const next = chips.filter((chip) => addrEmail(chip).toLowerCase() !== email);
      emit(next, trailingIsChip ? '' : draft);
    } else {
      emit([...committed, formatRecipient(c)], '');
    }
    skipNextLookup.current = true;
    setActive(0);
    setOpen(true);
    inputRef.current?.focus();
  }

  function removeChip(index: number) {
    const next = chips.filter((_, i) => i !== index);
    // Keep an in-progress (non-chip) token; a removed trailing chip just drops away.
    emit(next, trailingIsChip ? '' : draft);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (open && list.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (i + 1) % list.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i - 1 + list.length) % list.length);
        return;
      }
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (open && list[activeIdx]) {
        e.preventDefault();
        toggleContact(list[activeIdx]);
      } else if (draft.trim()) {
        e.preventDefault();
        commitDraft();
      }
    } else if (e.key === ',' || e.key === ';') {
      if (draft.trim()) {
        e.preventDefault();
        commitDraft();
      }
    } else if (e.key === 'Backspace' && inputText === '' && chips.length) {
      e.preventDefault();
      removeChip(chips.length - 1);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div className="relative flex-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((chip, i) => {
          const valid = isValidEmail(chip);
          return (
            <span
              key={`${chip}-${i}`}
              className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs ${
                valid ? 'bg-surface-2 text-fg' : 'bg-danger/15 text-danger'
              }`}
              title={chip}
            >
              <span className="max-w-[40vw] truncate">{chipLabel(chip)}</span>
              <button
                type="button"
                // Keep the input focused so the picker doesn't close mid-edit.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => removeChip(i)}
                className="text-faint active:text-fg"
                aria-label={`Remove ${chipLabel(chip)}`}
              >
                ✕
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          value={inputText}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() =>
            setTimeout(() => {
              setFocused(false);
              setOpen(false);
              setBrowse(false);
            }, 120)
          }
          autoFocus={autoFocus}
          inputMode="email"
          autoCapitalize="off"
          autoComplete="off"
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          placeholder={chips.length ? '' : placeholder}
          className="min-w-[10ch] flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
        />
        <button
          type="button"
          // Keep the input focused so the picker doesn't blur-close as it opens.
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleBrowse}
          className={`shrink-0 rounded-full p-1 active:text-fg ${
            browse && open ? 'text-accent' : 'text-faint'
          }`}
          aria-label="Browse contacts"
          aria-pressed={browse && open}
        >
          <UsersIcon className="size-5" />
        </button>
      </div>
      {open && (list.length > 0 || showCreate) && (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-lg border border-border bg-surface shadow-lg"
        >
          {list.map((c, i) => {
            const isAdded = added.has(c.email.toLowerCase());
            return (
              <li
                key={`${c.email}-${i}`}
                role="option"
                aria-selected={i === activeIdx}
                aria-checked={isAdded}
              >
                <button
                  type="button"
                  // mousedown fires before the input's blur so the pick isn't lost.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    toggleContact(c);
                  }}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${
                    i === activeIdx ? 'bg-surface-2' : 'active:bg-surface-2'
                  }`}
                >
                  <span
                    className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${
                      isAdded
                        ? 'border-accent bg-accent text-white'
                        : 'border-border text-transparent'
                    }`}
                  >
                    <CheckIcon className="size-3.5" />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    {c.name && <span className="truncate text-[15px] leading-tight">{c.name}</span>}
                    <span className={`truncate text-xs ${c.name ? 'text-faint' : 'text-[15px]'}`}>
                      {c.email}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          {showCreate && (
            <li role="option" aria-selected={false}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setCreatingEmail(addrEmail(draft));
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-accent active:bg-surface-2"
              >
                <span className="flex size-5 shrink-0 items-center justify-center">
                  <PlusIcon className="size-4" />
                </span>
                <span className="min-w-0 truncate text-[15px]">
                  Create contact “{addrEmail(draft)}”
                </span>
              </button>
            </li>
          )}
        </ul>
      )}

      {creatingEmail !== null && (
        <ContactEditor
          card={null}
          initialEmail={creatingEmail}
          onClose={() => setCreatingEmail(null)}
          onSaved={() => {
            setCreatingEmail(null);
            // Keep the typed address as a recipient; refresh the cached book so the
            // new card is recognised next time the picker opens.
            commitDraft();
            setAllContacts(null);
            setOpen(false);
            setBrowse(false);
          }}
        />
      )}
    </div>
  );
}
