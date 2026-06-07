/**
 * Inline Action Center offers for the open message (the reader chip, ROADMAP Phase 4
 * "surface each proposal inline on its source message, not only in the hub"). Renders
 * nothing when there are no live offers, so it's invisible on ordinary mail. Resolving
 * one here removes it and decrements the global badge — same offer, same data as the hub.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ProposalDto } from '@maily/shared';
import { api } from '../../api/client';
import { adjustActionCount } from '../../state/actions';
import { ProposalItem } from './ProposalItem';

export function MessageActions({ messageId }: { messageId: string }) {
  const [proposals, setProposals] = useState<ProposalDto[]>([]);

  useEffect(() => {
    let active = true;
    api
      .messageActions(messageId)
      .then((list) => active && setProposals(list))
      .catch(() => active && setProposals([]));
    return () => {
      active = false;
    };
  }, [messageId]);

  const onResolved = useCallback((id: string) => {
    setProposals((prev) => prev.filter((p) => p.id !== id));
    adjustActionCount(-1);
  }, []);

  if (proposals.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
      {proposals.map((p) => (
        <ProposalItem key={p.id} proposal={p} showSource={false} onResolved={onResolved} />
      ))}
    </div>
  );
}
