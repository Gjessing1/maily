/**
 * Action Center hub (ROADMAP Phase 4). A convenience view over the pipeline's
 * `derived`-stage proposals — *not* a second inbox: every offer also surfaces inline
 * on its source message (the reader chip), un-acted offers expire server-side, and an
 * empty list is the happy path, not a backlog to clear. Each row renders through its
 * type's view (`registry.tsx`), so new proposal kinds appear here for free.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ProposalDto } from '@maily/shared';
import { api } from '../api/client';
import { onSignal } from '../api/socket';
import { adjustActionCount, refreshActionCount } from '../state/actions';
import { ProposalItem } from '../components/proposals/ProposalItem';
import { Spinner } from '../ui/Spinner';
import { BackIcon, BoltIcon } from '../ui/icons';

export function Actions() {
  const navigate = useNavigate();
  const [proposals, setProposals] = useState<ProposalDto[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(false);
      setProposals(await api.actions());
      void refreshActionCount();
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A fresh offer arriving while the hub is open pulls it into the list.
  useEffect(() => onSignal((s) => s.type === 'action:ready' && void load()), [load]);

  const onResolved = useCallback((id: string) => {
    setProposals((prev) => (prev ? prev.filter((p) => p.id !== id) : prev));
    adjustActionCount(-1);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top sticky top-0 z-10 flex items-center gap-1 border-b border-border bg-bg/85 px-2 py-2 backdrop-blur">
        <button
          onClick={() => navigate(-1)}
          className="rounded-full p-2 text-fg active:bg-surface-2"
          aria-label="Back"
        >
          <BackIcon />
        </button>
        <h1 className="flex-1 truncate px-2 text-lg font-semibold">Actions</h1>
      </header>

      <main className="flex-1 overflow-y-auto no-scrollbar">
        {error && proposals === null ? (
          <p className="px-4 py-8 text-center text-danger">Couldn’t load actions.</p>
        ) : proposals === null ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : proposals.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-24 text-center text-muted">
            <span className="flex size-14 items-center justify-center rounded-full bg-surface text-faint">
              <BoltIcon className="size-7" />
            </span>
            <p className="font-medium text-fg">You’re all caught up</p>
            <p className="max-w-xs text-sm">
              Suggested actions from your mail — like adding a trip to your calendar — show up here.
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4">
            {proposals.map((p) => (
              <ProposalItem key={p.id} proposal={p} onResolved={onResolved} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
