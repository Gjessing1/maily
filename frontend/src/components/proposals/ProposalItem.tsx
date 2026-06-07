/**
 * A single Action Center offer, rendered through its type's view (`registry.tsx`).
 * Used both in the hub (`showSource` → source sender/subject + deep-link) and inline
 * in the reader (`showSource={false}`, since the open message *is* the source).
 *
 * Owns its own approve/dismiss calls + busy/error state and reports the resolved id up
 * via `onResolved` so the parent can drop it optimistically. An offer is an *offer*:
 * approve runs the side effect (where one is wired) and dismiss just clears it — either
 * way it leaves the list. Nothing nags; un-acted offers expire server-side.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ProposalDto } from '@maily/shared';
import { api } from '../../api/client';
import { proposalView } from './registry';
import { senderName, shortDate } from '../../ui/format';
import { CheckIcon, CloseIcon } from '../../ui/icons';
import { Spinner } from '../../ui/Spinner';

export function ProposalItem({
  proposal,
  showSource = true,
  onResolved,
}: {
  proposal: ProposalDto;
  showSource?: boolean;
  onResolved: (id: string) => void;
}) {
  const [busy, setBusy] = useState<null | 'approve' | 'dismiss'>(null);
  const [failed, setFailed] = useState(false);
  const view = proposalView(proposal.type);
  const details = view.details(proposal.payload);
  const title = proposal.title?.trim() || view.kind;

  async function run(kind: 'approve' | 'dismiss') {
    if (busy) return;
    setBusy(kind);
    setFailed(false);
    try {
      if (kind === 'approve') await api.approveAction(proposal.id);
      else await api.dismissAction(proposal.id);
      onResolved(proposal.id);
    } catch {
      setFailed(true);
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
          <view.Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-faint">{view.kind}</p>
          <p className="truncate font-medium text-fg">{title}</p>
          {details.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {details.map((d, i) => (
                <li key={i} className="flex items-center gap-1.5 text-sm text-muted">
                  {d.Icon && <d.Icon className="size-4 shrink-0 text-faint" />}
                  <span className="min-w-0 truncate">{d.text}</span>
                </li>
              ))}
            </ul>
          )}
          {showSource && proposal.source && (
            <Link
              to={`/m/${proposal.messageId}`}
              className="mt-1.5 flex min-w-0 items-center gap-1 text-xs text-faint hover:text-accent"
            >
              <span className="truncate">
                {senderName(proposal.source.fromName, proposal.source.fromAddress)}
                {proposal.source.subject ? ` · ${proposal.source.subject}` : ''}
              </span>
              {proposal.source.receivedAt && (
                <span className="shrink-0">· {shortDate(proposal.source.receivedAt)}</span>
              )}
            </Link>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        {failed && (
          <span className="mr-auto text-xs text-danger">Couldn’t complete — try again.</span>
        )}
        <button
          onClick={() => run('dismiss')}
          disabled={!!busy}
          className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium text-muted active:bg-surface-2 disabled:opacity-50"
        >
          {busy === 'dismiss' ? <Spinner className="size-4" /> : <CloseIcon className="size-4" />}
          Dismiss
        </button>
        <button
          onClick={() => run('approve')}
          disabled={!!busy}
          className="flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-sm font-medium text-white active:scale-95 disabled:opacity-50"
        >
          {busy === 'approve' ? <Spinner className="size-4" /> : <CheckIcon className="size-4" />}
          {view.approveLabel}
        </button>
      </div>
    </div>
  );
}
