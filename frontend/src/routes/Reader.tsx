import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { patchCachedFlags, removeCachedMessage } from '../db/cache';
import { useAccounts, useMessageDetail } from '../state/data';
import { MailHtml, MailText } from '../components/MailBody';
import { AttachmentChip } from '../components/AttachmentChip';
import { Spinner } from '../ui/Spinner';
import { BackIcon, ForwardIcon, ReplyAllIcon, ReplyIcon, StarIcon, TrashIcon } from '../ui/icons';
import { avatarHue, fullDate, initials, senderName } from '../ui/format';
import type { ComposeAttachment, ComposePrefill } from './Compose';

export function Reader() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { detail, loading, error } = useMessageDetail(id);
  const accounts = useAccounts();
  const [flagged, setFlagged] = useState(false);
  const markedSeen = useRef(false);

  // Reflect server flag state once the detail loads.
  useEffect(() => {
    if (detail) setFlagged(detail.flagged);
  }, [detail]);

  // Mark as read on first open (optimistic; server is authoritative).
  useEffect(() => {
    if (!detail || detail.seen || markedSeen.current) return;
    markedSeen.current = true;
    void patchCachedFlags(detail.id, { seen: true });
    api.setFlags(detail.id, { seen: true }).catch(() => undefined);
  }, [detail]);

  async function toggleStar() {
    if (!detail) return;
    const next = !flagged;
    setFlagged(next);
    void patchCachedFlags(detail.id, { flagged: next });
    try {
      await api.setFlags(detail.id, { flagged: next });
    } catch {
      setFlagged(!next); // revert on failure
      void patchCachedFlags(detail.id, { flagged: !next });
    }
  }

  // Addresses belonging to us — excluded from reply-all so we don't reply to ourselves.
  const ownAddresses = new Set((accounts ?? []).map((a) => a.email.toLowerCase()));

  function quotedReply(): string {
    if (!detail?.bodyText) return '';
    const lead = `On ${fullDate(detail.sentAt ?? detail.receivedAt)}, ${senderName(
      detail.fromName,
      detail.fromAddress,
    )} wrote:`;
    const body = detail.bodyText
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n');
    return `\n\n${lead}\n${body}`;
  }

  function replyCommon(): ComposePrefill {
    const subject = detail!.subject ?? '';
    return {
      accountId: detail!.accountId,
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      body: quotedReply(),
      inReplyTo: detail!.messageId,
      references: [detail!.references, detail!.messageId].filter(Boolean).join(' ') || null,
    };
  }

  /** Dedup (case-insensitive), preserving order and dropping our own + excluded addresses. */
  function pickAddrs(addrs: string[], exclude: Set<string>): string[] {
    const seen = new Set(exclude);
    const out: string[] = [];
    for (const a of addrs) {
      const key = a.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
    return out;
  }

  function reply() {
    if (!detail) return;
    navigate('/compose', {
      state: { ...replyCommon(), to: detail.fromAddress ? [detail.fromAddress] : [] },
    });
  }

  function replyAll() {
    if (!detail) return;
    const to = pickAddrs(
      [detail.fromAddress ?? '', ...detail.to.map((a) => a.address)].filter(Boolean),
      ownAddresses,
    );
    // Cc carries the remaining recipients, minus anyone already in To.
    const cc = pickAddrs(
      detail.cc.map((a) => a.address),
      new Set([...ownAddresses, ...to.map((a) => a.toLowerCase())]),
    );
    navigate('/compose', { state: { ...replyCommon(), to, cc } });
  }

  async function remove() {
    if (!detail) return;
    // Optimistic: drop from cache + leave the reader immediately; the server moves
    // the message to Trash out-of-band. We don't revert on failure — the next folder
    // resync is authoritative either way.
    void removeCachedMessage(detail.id);
    navigate(-1);
    api.deleteMessage(detail.id).catch(() => undefined);
  }

  function forward() {
    if (!detail) return;
    const subject = detail.subject ?? '';
    const header = [
      '---------- Forwarded message ----------',
      `From: ${senderName(detail.fromName, detail.fromAddress)}`,
      `Date: ${fullDate(detail.sentAt ?? detail.receivedAt)}`,
      `Subject: ${subject}`,
      detail.to.length ? `To: ${detail.to.map((a) => a.address).join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const fwdAttachments: ComposeAttachment[] = visibleAttachments.map((a) => ({
      messageId: detail.id,
      attachmentId: a.id,
      filename: a.filename,
    }));
    navigate('/compose', {
      state: {
        accountId: detail.accountId,
        subject: /^fwd:/i.test(subject) ? subject : `Fwd: ${subject}`,
        body: `\n\n${header}\n\n${detail.bodyText ?? ''}`,
        attachments: fwdAttachments,
      } satisfies ComposePrefill,
    });
  }

  const hue = detail ? avatarHue(detail.fromAddress ?? detail.id) : 0;
  const visibleAttachments = detail?.attachments.filter((a) => !a.isInline) ?? [];

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top sticky top-0 z-10 flex items-center gap-1 border-b border-border bg-bg/85 px-2 py-2 backdrop-blur">
        <button
          onClick={() => navigate(-1)}
          className="rounded-full p-2 active:bg-surface-2"
          aria-label="Back"
        >
          <BackIcon />
        </button>
        <div className="flex-1" />
        <button
          onClick={toggleStar}
          className="rounded-full p-2 active:bg-surface-2"
          aria-label="Flag"
        >
          <StarIcon className={flagged ? 'fill-accent text-accent' : 'text-fg'} />
        </button>
        <button
          onClick={remove}
          className="rounded-full p-2 active:bg-surface-2"
          aria-label="Delete"
        >
          <TrashIcon className="text-fg" />
        </button>
        <button onClick={reply} className="rounded-full p-2 active:bg-surface-2" aria-label="Reply">
          <ReplyIcon className="text-fg" />
        </button>
        <button
          onClick={replyAll}
          className="rounded-full p-2 active:bg-surface-2"
          aria-label="Reply all"
        >
          <ReplyAllIcon className="text-fg" />
        </button>
        <button
          onClick={forward}
          className="rounded-full p-2 active:bg-surface-2"
          aria-label="Forward"
        >
          <ForwardIcon className="text-fg" />
        </button>
      </header>

      <main className="flex-1 overflow-y-auto no-scrollbar">
        {loading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : error && !detail ? (
          <p className="px-4 py-8 text-center text-danger">Couldn’t load this message.</p>
        ) : detail ? (
          <article>
            <div className="px-4 pb-4 pt-3">
              <h1 className="text-xl font-semibold leading-snug">
                {detail.subject || '(no subject)'}
              </h1>
              <div className="mt-3 flex items-center gap-3">
                <div
                  className="flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
                  style={{ backgroundColor: `hsl(${hue} 45% 42%)` }}
                >
                  {initials(detail.fromName, detail.fromAddress)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {senderName(detail.fromName, detail.fromAddress)}
                  </p>
                  <p className="truncate text-xs text-faint">
                    {fullDate(detail.receivedAt ?? detail.sentAt)}
                  </p>
                </div>
              </div>
            </div>

            <div className="border-t border-border">
              {detail.bodyHtml ? (
                <MailHtml html={detail.bodyHtml} />
              ) : (
                <div className="px-4 py-3">
                  <MailText text={detail.bodyText ?? '(no content)'} />
                </div>
              )}
            </div>

            {visibleAttachments.length > 0 && (
              <div className="flex flex-wrap gap-2 border-t border-border px-4 py-4">
                {visibleAttachments.map((a) => (
                  <AttachmentChip key={a.id} messageId={detail.id} attachment={a} />
                ))}
              </div>
            )}
            <div className="h-12" />
          </article>
        ) : null}
      </main>
    </div>
  );
}
