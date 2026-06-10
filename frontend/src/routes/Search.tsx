/**
 * Search screen (ROADMAP §3.7.D Advanced Search — the query IR's first consumer).
 * One text box, two ways to use it: power users type operators (`from:` `is:unread`
 * `filename:` …) straight into the box; everyone else opens **Filters**, a structured
 * form whose fields compile into the same operator string. The composed query is shown
 * under the form ("Runs as: …") so the syntax teaches itself. The backend parses the
 * string into the canonical IR and compiles it to FTS5 + SQL (`search/query.ts`).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MessageDto } from '@maily/shared';
import { api } from '../api/client';
import { MessageRow } from '../components/MessageRow';
import { Spinner } from '../ui/Spinner';
import { BackIcon, ChevronDownIcon, SearchIcon } from '../ui/icons';

/** The structured filter form — each field maps 1:1 to a query operator. */
interface Filters {
  from: string;
  to: string;
  subject: string;
  /** ISO dates from the native date inputs (YYYY-MM-DD), '' = unset. */
  since: string;
  before: string;
  hasAttachment: boolean;
  filename: string;
  /** Minimum attachment size, as an operator value ('' = unset, e.g. '5M'). */
  larger: string;
  unread: boolean;
  flagged: boolean;
}

const EMPTY_FILTERS: Filters = {
  from: '',
  to: '',
  subject: '',
  since: '',
  before: '',
  hasAttachment: false,
  filename: '',
  larger: '',
  unread: false,
  flagged: false,
};

/** Quote an operator value when it contains whitespace (`to:"bob jones"`). */
function opValue(v: string): string {
  return /\s/.test(v) ? `"${v}"` : v;
}

/** Compose free text + the filter form into the operator query string the backend parses. */
function buildQuery(text: string, f: Filters): string {
  const parts: string[] = [];
  if (text.trim()) parts.push(text.trim());
  if (f.from.trim()) parts.push(`from:${opValue(f.from.trim())}`);
  if (f.to.trim()) parts.push(`to:${opValue(f.to.trim())}`);
  if (f.subject.trim()) parts.push(`subject:${opValue(f.subject.trim())}`);
  if (f.since) parts.push(`since:${f.since}`);
  if (f.before) parts.push(`before:${f.before}`);
  if (f.hasAttachment) parts.push('has:attachment');
  if (f.filename.trim()) parts.push(`filename:${opValue(f.filename.trim())}`);
  if (f.larger) parts.push(`larger:${f.larger}`);
  if (f.unread) parts.push('is:unread');
  if (f.flagged) parts.push('is:flagged');
  return parts.join(' ');
}

/** A labelled text/date input row of the filter form. */
function FilterField({
  label,
  type = 'text',
  value,
  onChange,
  placeholder,
}: {
  label: string;
  type?: 'text' | 'date';
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="w-24 shrink-0 text-muted">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoCapitalize="off"
        className="min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-fg outline-none placeholder:text-faint"
      />
    </label>
  );
}

/** A toggle chip of the filter form (checkbox semantics, pill look). */
function FilterChip({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
        checked
          ? 'border-accent bg-accent text-white'
          : 'border-border bg-surface text-muted active:bg-surface-2'
      }`}
    >
      {label}
    </button>
  );
}

export function Search() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [results, setResults] = useState<MessageDto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const query = useMemo(() => buildQuery(q, filters), [q, filters]);
  const filtersActive = useMemo(() => buildQuery('', filters) !== '', [filters]);

  // Debounced search over the composed query; backend does FTS5 locally then falls
  // back to IMAP for older mail (ARCHITECTURE §1).
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!query) {
      setResults(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    timer.current = setTimeout(() => {
      api
        .search(query)
        .then((rows) => {
          setResults(rows);
          setError(null);
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setBusy(false));
    }, 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query]);

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top sticky top-0 z-10 border-b border-border bg-bg/85 px-2 py-2 backdrop-blur">
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate(-1)}
            className="rounded-full p-2 active:bg-surface-2"
            aria-label="Back"
          >
            <BackIcon />
          </button>
          <div className="flex flex-1 items-center gap-2 rounded-full bg-surface px-3 py-2">
            <SearchIcon className="size-4 text-faint" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search mail"
              autoCapitalize="off"
              className="flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
            />
            {busy && <Spinner className="size-4" />}
          </div>
          <button
            type="button"
            onClick={() => setShowFilters((s) => !s)}
            aria-expanded={showFilters}
            className={`flex shrink-0 items-center gap-1 rounded-full px-3 py-2 text-sm font-medium active:bg-surface-2 ${
              filtersActive ? 'text-accent' : 'text-muted'
            }`}
          >
            Filters
            <ChevronDownIcon
              className={`size-4 transition-transform ${showFilters ? 'rotate-180' : ''}`}
            />
          </button>
        </div>

        {showFilters && (
          <div className="mx-auto mt-2 flex max-w-2xl flex-col gap-2 rounded-xl border border-border bg-surface p-3">
            <FilterField
              label="From"
              value={filters.from}
              onChange={(v) => set('from', v)}
              placeholder="name or address"
            />
            <FilterField
              label="To"
              value={filters.to}
              onChange={(v) => set('to', v)}
              placeholder="name or address"
            />
            <FilterField
              label="Subject"
              value={filters.subject}
              onChange={(v) => set('subject', v)}
              placeholder="words in the subject"
            />
            <FilterField
              label="Since"
              type="date"
              value={filters.since}
              onChange={(v) => set('since', v)}
            />
            <FilterField
              label="Before"
              type="date"
              value={filters.before}
              onChange={(v) => set('before', v)}
            />
            <FilterField
              label="Attachment"
              value={filters.filename}
              onChange={(v) => set('filename', v)}
              placeholder="filename contains…"
            />
            <label className="flex items-center gap-2 text-sm">
              <span className="w-24 shrink-0 text-muted">Larger than</span>
              <select
                value={filters.larger}
                onChange={(e) => set('larger', e.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-fg outline-none"
              >
                <option value="">Any size</option>
                <option value="1M">1 MB</option>
                <option value="5M">5 MB</option>
                <option value="10M">10 MB</option>
                <option value="25M">25 MB</option>
              </select>
            </label>
            <div className="flex flex-wrap gap-2 pt-1">
              <FilterChip
                label="Has attachment"
                checked={filters.hasAttachment}
                onChange={(v) => set('hasAttachment', v)}
              />
              <FilterChip
                label="Unread"
                checked={filters.unread}
                onChange={(v) => set('unread', v)}
              />
              <FilterChip
                label="Flagged"
                checked={filters.flagged}
                onChange={(v) => set('flagged', v)}
              />
            </div>
            {filtersActive && (
              <div className="flex items-center justify-between gap-2 pt-1">
                {/* Show the composed operator query — the form teaches the syntax. */}
                <code className="min-w-0 flex-1 truncate text-xs text-faint">{query}</code>
                <button
                  type="button"
                  onClick={() => setFilters(EMPTY_FILTERS)}
                  className="shrink-0 text-xs font-medium text-accent active:opacity-80"
                >
                  Clear filters
                </button>
              </div>
            )}
          </div>
        )}
      </header>

      <main className="flex-1 overflow-y-auto no-scrollbar">
        {error && <p className="px-4 py-2 text-sm text-danger">{error}</p>}
        {results === null ? (
          <div className="px-6 py-16 text-center text-faint">
            <p>Search subjects, senders, and bodies — or open Filters above.</p>
            <p className="mt-3 text-xs leading-relaxed">
              Operators: <code className="text-muted">from:</code>{' '}
              <code className="text-muted">to:</code> <code className="text-muted">subject:</code>{' '}
              <code className="text-muted">since:</code> <code className="text-muted">before:</code>{' '}
              <code className="text-muted">has:attachment</code>{' '}
              <code className="text-muted">filename:</code>{' '}
              <code className="text-muted">larger:1M</code>{' '}
              <code className="text-muted">is:unread</code>{' '}
              <code className="text-muted">is:flagged</code>
            </p>
          </div>
        ) : results.length === 0 && !busy ? (
          <p className="px-4 py-16 text-center text-faint">No matches.</p>
        ) : (
          results.map((m) => <MessageRow key={m.id} message={m} />)
        )}
      </main>
    </div>
  );
}
