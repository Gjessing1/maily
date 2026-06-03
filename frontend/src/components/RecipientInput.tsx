/**
 * Recipient field with CardDAV contact autocomplete (ROADMAP §3.7.D). The value is
 * a raw comma/semicolon-separated address string (parsed by the composer on send);
 * this component only autocompletes the address currently being typed — the token
 * after the last separator — and replaces it with the chosen contact.
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

/** Format a chosen contact as a recipient token (display name when present). */
function formatRecipient(c: ContactDto): string {
  return c.name ? `${c.name} <${c.email}>` : c.email;
}

/** Split the field into the committed prefix and the in-progress trailing token. */
function splitTrailing(value: string): { prefix: string; token: string } {
  const idx = Math.max(value.lastIndexOf(','), value.lastIndexOf(';'));
  return idx < 0
    ? { prefix: '', token: value }
    : { prefix: value.slice(0, idx + 1), token: value.slice(idx + 1) };
}

export function RecipientInput({ value, onChange, placeholder, autoFocus, ariaLabel }: Props) {
  const [suggestions, setSuggestions] = useState<ContactDto[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  // Suppress the lookup that would otherwise fire immediately after a pick.
  const skipNextLookup = useRef(false);

  const token = splitTrailing(value).token.trim();

  useEffect(() => {
    if (skipNextLookup.current) {
      skipNextLookup.current = false;
      return;
    }
    if (token.length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      api
        .contacts(token)
        .then((rows) => {
          if (!alive) return;
          setSuggestions(rows);
          setActive(0);
          setOpen(rows.length > 0);
        })
        .catch(() => undefined);
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [token]);

  function pick(c: ContactDto) {
    const { prefix } = splitTrailing(value);
    const lead = prefix ? `${prefix.replace(/[;,]\s*$/, '')}, ` : '';
    skipNextLookup.current = true;
    onChange(`${lead}${formatRecipient(c)}, `);
    setOpen(false);
    setSuggestions([]);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      const choice = suggestions[active];
      if (choice) {
        e.preventDefault();
        pick(choice);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div className="relative flex-1">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        autoFocus={autoFocus}
        inputMode="email"
        autoCapitalize="off"
        autoComplete="off"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        placeholder={placeholder}
        className="w-full bg-transparent text-[15px] outline-none placeholder:text-faint"
      />
      {open && suggestions.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-lg border border-border bg-surface shadow-lg"
        >
          {suggestions.map((c, i) => (
            <li key={`${c.email}-${i}`} role="option" aria-selected={i === active}>
              <button
                type="button"
                // Use mousedown so the pick fires before the input's blur closes the list.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(c);
                }}
                className={`flex w-full flex-col items-start px-3 py-2 text-left ${
                  i === active ? 'bg-surface-2' : 'active:bg-surface-2'
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
