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
import { fullDate, senderName, shortDate } from '../ui/format';
import { joinAddrs, MessageHeaderDetails, SenderAvatar } from './MessageHeader';
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [flagged, setFlagged] = useState(message.flagged);
  const autoMarked = useRef(false);

  useEffect(() => setFlagged(message.flagged), [message.flagged]);
  // Reset the per-message overrides when a different message lands in this card.
  useEffect(() => {
    setShowImages(false);
    setDetailsOpen(false);
  }, [message.id]);

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

  const date = message.sentAt ?? message.receivedAt;
  const visibleAttachments = detail?.attachments.filter((a) => !a.isInline) ?? [];
  const hasAttachment = message.attachments.some((a) => !a.isInline);

  return (
    <div className={`border-b border-border ${!message.seen ? 'bg-accent-soft/40' : ''}`}>
      {/* Header row — the avatar is its own tap target (contact card); the rest
          collapses/expands the message. */}
      <div className="flex w-full items-center gap-3 px-4 py-3">
        <SenderAvatar
          name={message.fromName}
          address={message.fromAddress}
          seed={message.id}
          className="size-9 text-xs"
        />
        <button
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              {!message.seen && <span className="size-2 shrink-0 rounded-full bg-unread" />}
              <span
                className={`truncate text-[15px] ${message.seen ? 'text-fg' : 'font-semibold text-fg'}`}
              >
                {senderName(message.fromName, message.fromAddress)}
              </span>
              {flagged && (
                <StarIcon className="size-3.5 shrink-0 text-accent" fill="currentColor" />
              )}
              {hasAttachment && <PaperclipIcon className="size-3.5 shrink-0 text-faint" />}
              <span className="ml-auto shrink-0 text-xs text-faint">{shortDate(date)}</span>
            </span>
            {/* Collapsed only: snippet preview. Expanded, the recipient/date line below
                takes over (and doubles as the From/To/Cc disclosure). */}
            {!expanded && (
              <span className="mt-0.5 block truncate text-sm text-faint">
                {message.snippet || '(no preview)'}
              </span>
            )}
          </span>
          <ChevronDownIcon
            className={`size-4 shrink-0 text-faint transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        </button>
      </div>

      {/* Expanded: recipients + date, tappable for the full header block — same
          affordance a standalone message gets in the reader. */}
      {expanded && (
        <div className="px-4 pb-3 pl-16">
          <button
            onClick={() => setDetailsOpen((o) => !o)}
            aria-expanded={detailsOpen}
            className="flex w-full items-center gap-2 text-left"
          >
            <span className="min-w-0 flex-1 truncate text-xs text-faint">
              {detail && detail.to.length > 0 ? `to ${joinAddrs(detail.to)} · ` : ''}
              {fullDate(date)}
            </span>
            <ChevronDownIcon
              className={`size-3.5 shrink-0 text-faint transition-transform ${detailsOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {detailsOpen && detail && (
            <div className="mt-2">
              <MessageHeaderDetails detail={detail} />
            </div>
          )}
        </div>
      )}

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
