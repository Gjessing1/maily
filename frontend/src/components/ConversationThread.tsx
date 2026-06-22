/**
 * Threaded conversation reader (ARCHITECTURE §11): the messages of one thread stacked
 * as collapsible cards. The opened / latest / any-unread messages start expanded; the
 * rest collapse to a one-line summary and lazy-load their body on tap (bodies stay off
 * the wire until needed, ARCHITECTURE §3/§4). Order follows the `newestMessageFirst`
 * preference. Each expanded card carries its own reply/forward/flag actions so the user
 * can act on a specific message in the chain, not just the latest.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AccountDto, MessageDto } from '@maily/shared';
import { api } from '../api/client';
import { patchCachedFlags } from '../db/cache';
import { useMessageDetail } from '../state/data';
import { usePrefs } from '../state/prefs';
import { isImageDomainTrusted, senderDomain, trustImageDomain } from '../state/trustedImages';
import { buildForward, buildReply, buildReplyAll } from '../state/replyPrefill';
import { avatarHue, fullDate, initials, senderName, shortDate } from '../ui/format';
import { hasRemoteImages, MailHtml, MailText } from './MailBody';
import { AttachmentChip } from './AttachmentChip';
import { ImageAttachment, isImageAttachment } from './ImageAttachment';
import { Spinner } from '../ui/Spinner';
import {
  ChevronDownIcon,
  ForwardIcon,
  MailIcon,
  PaperclipIcon,
  ReplyAllIcon,
  ReplyIcon,
  StarIcon,
} from '../ui/icons';

/** One message in the stack — collapsed summary or expanded full body + actions. */
function ConversationMessage({
  message,
  defaultExpanded,
  accounts,
}: {
  message: MessageDto;
  defaultExpanded: boolean;
  accounts: AccountDto[];
}) {
  const navigate = useNavigate();
  const { blockRemoteImages, markReadSeconds, trustedImageDomains } = usePrefs();
  const [expanded, setExpanded] = useState(defaultExpanded);
  // Body is fetched only while expanded — collapsed cards cost nothing.
  const { detail, loading } = useMessageDetail(expanded ? message.id : undefined);
  const [showImages, setShowImages] = useState(false);
  const [flagged, setFlagged] = useState(message.flagged);
  const autoMarked = useRef(false);

  useEffect(() => setFlagged(message.flagged), [message.flagged]);
  // Reset the per-message image override when a different message lands in this card.
  useEffect(() => setShowImages(false), [message.id]);

  // Auto-mark read once when the card is expanded (honours the dwell pref; -1 = never).
  useEffect(() => {
    if (!expanded || autoMarked.current || message.seen || markReadSeconds < 0) return;
    autoMarked.current = true;
    const mark = () => {
      void patchCachedFlags(message.id, { seen: true });
      api.setFlags(message.id, { seen: true }).catch(() => undefined);
    };
    if (markReadSeconds === 0) {
      mark();
      return;
    }
    const t = setTimeout(mark, markReadSeconds * 1000);
    return () => clearTimeout(t);
  }, [expanded, message.id, message.seen, markReadSeconds]);

  function toggleStar(e: React.MouseEvent) {
    e.stopPropagation();
    const next = !flagged;
    setFlagged(next);
    void patchCachedFlags(message.id, { flagged: next });
    api.setFlags(message.id, { flagged: next }).catch(() => {
      setFlagged(!next);
      void patchCachedFlags(message.id, { flagged: !next });
    });
  }

  const senderTrusted = isImageDomainTrusted(detail?.fromAddress, trustedImageDomains);
  const allowImages = !blockRemoteImages || showImages || senderTrusted;
  const imagesBlocked =
    blockRemoteImages &&
    !showImages &&
    !senderTrusted &&
    Boolean(detail?.bodyHtml && hasRemoteImages(detail.bodyHtml));
  const trustDomain = senderDomain(detail?.fromAddress);

  const hue = avatarHue(message.fromAddress ?? message.id);
  const date = message.sentAt ?? message.receivedAt;
  const visibleAttachments = detail?.attachments.filter((a) => !a.isInline) ?? [];
  const hasAttachment = message.attachments.some((a) => !a.isInline);

  return (
    <div className={`border-b border-border ${!message.seen ? 'bg-accent-soft/40' : ''}`}>
      {/* Header row — always the tap target to collapse/expand. */}
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-2"
      >
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
          style={{ backgroundColor: `hsl(${hue} 45% 42%)` }}
        >
          {initials(message.fromName, message.fromAddress)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            {!message.seen && <span className="size-2 shrink-0 rounded-full bg-unread" />}
            <span
              className={`truncate text-[15px] ${message.seen ? 'text-fg' : 'font-semibold text-fg'}`}
            >
              {senderName(message.fromName, message.fromAddress)}
            </span>
            {flagged && <StarIcon className="size-3.5 shrink-0 text-accent" fill="currentColor" />}
            {hasAttachment && <PaperclipIcon className="size-3.5 shrink-0 text-faint" />}
            <span className="ml-auto shrink-0 text-xs text-faint">{shortDate(date)}</span>
          </span>
          {/* Collapsed: snippet preview. Expanded: full date line. */}
          <span className="mt-0.5 block truncate text-sm text-faint">
            {expanded ? fullDate(date) : message.snippet || '(no preview)'}
          </span>
        </span>
        <ChevronDownIcon
          className={`size-4 shrink-0 text-faint transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {expanded && (
        <div>
          {loading || !detail ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : (
            <>
              {imagesBlocked && (
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 bg-surface px-4 py-2 text-sm">
                  <span className="text-muted">Remote images blocked for privacy.</span>
                  <div className="flex shrink-0 items-center gap-4">
                    {trustDomain && (
                      <button
                        onClick={() => trustImageDomain(trustDomain)}
                        className="font-medium text-accent active:opacity-70"
                      >
                        Always trust {trustDomain}
                      </button>
                    )}
                    <button
                      onClick={() => setShowImages(true)}
                      className="font-medium text-accent active:opacity-70"
                    >
                      Show images
                    </button>
                  </div>
                </div>
              )}
              {detail.bodyHtml ? (
                <MailHtml html={detail.bodyHtml} allowImages={allowImages} />
              ) : (
                <div className="px-4 py-3">
                  <MailText text={detail.bodyText ?? '(no content)'} />
                </div>
              )}

              {visibleAttachments.length > 0 && (
                <div className="space-y-2 border-t border-border px-4 py-3">
                  {visibleAttachments.filter(isImageAttachment).map((a) => (
                    <ImageAttachment key={a.id} messageId={detail.id} attachment={a} />
                  ))}
                  {visibleAttachments.some((a) => !isImageAttachment(a)) && (
                    <div className="flex flex-wrap gap-2">
                      {visibleAttachments
                        .filter((a) => !isImageAttachment(a))
                        .map((a) => (
                          <AttachmentChip key={a.id} messageId={detail.id} attachment={a} />
                        ))}
                    </div>
                  )}
                </div>
              )}

              {/* Per-message actions: reply to THIS message in the chain. */}
              <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
                <button
                  onClick={() =>
                    navigate('/compose', { state: { ...buildReply(detail), fresh: true } })
                  }
                  className="rounded-full p-2 active:bg-surface-2"
                  aria-label="Reply"
                >
                  <ReplyIcon className="text-fg" />
                </button>
                <button
                  onClick={() =>
                    navigate('/compose', {
                      state: { ...buildReplyAll(detail, accounts), fresh: true },
                    })
                  }
                  className="rounded-full p-2 active:bg-surface-2"
                  aria-label="Reply all"
                >
                  <ReplyAllIcon className="text-fg" />
                </button>
                <button
                  onClick={() =>
                    navigate('/compose', { state: { ...buildForward(detail), fresh: true } })
                  }
                  className="rounded-full p-2 active:bg-surface-2"
                  aria-label="Forward"
                >
                  <ForwardIcon className="text-fg" />
                </button>
                <div className="flex-1" />
                <button
                  onClick={() => {
                    void patchCachedFlags(message.id, { seen: false });
                    api.setFlags(message.id, { seen: false }).catch(() => undefined);
                  }}
                  className="rounded-full p-2 active:bg-surface-2"
                  aria-label="Mark as unread"
                >
                  <MailIcon className="text-fg" />
                </button>
                <button
                  onClick={toggleStar}
                  className="rounded-full p-2 active:bg-surface-2"
                  aria-label={flagged ? 'Unstar' : 'Star'}
                >
                  <StarIcon className={flagged ? 'fill-accent text-accent' : 'text-fg'} />
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ConversationThread({
  members,
  openId,
  accounts,
}: {
  /** Thread members, oldest-first. */
  members: MessageDto[];
  /** The message the user opened — always starts expanded. */
  openId: string | undefined;
  accounts: AccountDto[];
}) {
  const { newestMessageFirst } = usePrefs();
  const latestId = members[members.length - 1]?.id;

  // Display order per preference; the chronological `members` is the source of truth.
  const ordered = useMemo(
    () => (newestMessageFirst ? [...members].reverse() : members),
    [members, newestMessageFirst],
  );

  return (
    <div>
      {ordered.map((m) => (
        <ConversationMessage
          key={m.id}
          message={m}
          accounts={accounts}
          // Expand the opened message, the latest, and anything unread (Gmail-style).
          defaultExpanded={m.id === openId || m.id === latestId || !m.seen}
        />
      ))}
    </div>
  );
}
