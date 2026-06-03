import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MessageDto } from '@maily/shared';
import { api } from '../api/client';
import { MessageRow } from '../components/MessageRow';
import { Spinner } from '../ui/Spinner';
import { BackIcon, SearchIcon } from '../ui/icons';

export function Search() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<MessageDto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounced search; backend does FTS5 locally then falls back to IMAP for
  // older mail (ARCHITECTURE §1).
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const term = q.trim();
    if (!term) {
      setResults(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    timer.current = setTimeout(() => {
      api
        .search(term)
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
  }, [q]);

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-bg/85 px-2 py-2 backdrop-blur">
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
      </header>

      <main className="flex-1 overflow-y-auto no-scrollbar">
        {error && <p className="px-4 py-2 text-sm text-danger">{error}</p>}
        {results === null ? (
          <div className="px-6 py-16 text-center text-faint">
            <p>Search subjects, senders, and bodies.</p>
            <p className="mt-3 text-xs leading-relaxed">
              Filters: <code className="text-muted">from:</code>{' '}
              <code className="text-muted">to:</code> <code className="text-muted">subject:</code>{' '}
              <code className="text-muted">since:</code> <code className="text-muted">before:</code>{' '}
              <code className="text-muted">has:attachment</code>{' '}
              <code className="text-muted">larger:1M</code>
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
