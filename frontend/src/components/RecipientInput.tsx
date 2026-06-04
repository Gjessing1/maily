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
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { ContactDto } from '@maily/shared';
import { api } from '../api/client';

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
  const [active, setActive] = useState(0);
  const [suggestions, setSuggestions] = useState<ContactDto[]>([]);
  // The whole addressbook, lazy-loaded once the picker first opens; shown when the
  // in-progress token is too short to search (so a blank field still lists contacts).
  const [allContacts, setAllContacts] = useState<ContactDto[] | null>(null);
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

  // What the dropdown shows: search hits when typing, else the whole book — minus
  // anything already added as a chip.
  const added = new Set(chips.map((c) => addrEmail(c).toLowerCase()));
  const source = query.length >= 2 ? suggestions : (allContacts ?? []);
  const list = source.filter((c) => !added.has(c.email.toLowerCase()));
  const activeIdx = active < list.length ? active : 0;

  /** Rebuild the value from the committed chips plus a trailing in-progress token. */
  function emit(chipTokens: string[], tail: string) {
    const lead = chipTokens.length ? `${chipTokens.join(', ')}, ` : '';
    onChange(lead + tail);
  }

  /** Replace the in-progress token as the user types. */
  function setInput(text: string) {
    emit(committed, text);
  }

  /** Turn the typed token into a chip (on Enter / comma / blur). */
  function commitDraft() {
    const t = draft.trim();
    if (!t) return;
    emit([...committed, t], '');
  }

  /** Add a picked contact as a chip, discarding the partial token, list stays open. */
  function addContact(c: ContactDto) {
    if (!added.has(c.email.toLowerCase())) emit([...committed, formatRecipient(c)], '');
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
        addContact(list[activeIdx]);
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
          onFocus={() => {
            setFocused(true);
            setOpen(true);
          }}
          onBlur={() =>
            setTimeout(() => {
              setFocused(false);
              setOpen(false);
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
      </div>
      {open && list.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-lg border border-border bg-surface shadow-lg"
        >
          {list.map((c, i) => (
            <li key={`${c.email}-${i}`} role="option" aria-selected={i === activeIdx}>
              <button
                type="button"
                // mousedown fires before the input's blur so the pick isn't lost.
                onMouseDown={(e) => {
                  e.preventDefault();
                  addContact(c);
                }}
                className={`flex w-full flex-col items-start px-3 py-2 text-left ${
                  i === activeIdx ? 'bg-surface-2' : 'active:bg-surface-2'
                }`}
              >
                {c.name && <span className="text-[15px] leading-tight">{c.name}</span>}
                <span className={`text-xs ${c.name ? 'text-faint' : 'text-[15px]'}`}>
                  {c.email}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
