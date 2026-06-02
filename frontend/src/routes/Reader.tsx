import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { patchCachedFlags } from '../db/cache';
import { useMessageDetail } from '../state/data';
import { MailHtml, MailText } from '../components/MailBody';
import { AttachmentChip } from '../components/AttachmentChip';
import { Spinner } from '../ui/Spinner';
import { BackIcon, SendIcon, StarIcon } from '../ui/icons';
import { avatarHue, fullDate, initials, senderName } from '../ui/format';
import type { ComposePrefill } from './Compose';

export function Reader() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { detail, loading, error } = useMessageDetail(id);
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

  function reply() {
    if (!detail) return;
    const subject = detail.subject ?? '';
    const quoted = detail.bodyText
      ? `\n\nOn ${fullDate(detail.sentAt ?? detail.receivedAt)}, ${senderName(
          detail.fromName,
          detail.fromAddress,
        )} wrote:\n${detail.bodyText
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n')}`
      : '';
    const prefill: ComposePrefill = {
      accountId: detail.accountId,
      to: detail.fromAddress ? [detail.fromAddress] : [],
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      body: quoted,
      inReplyTo: detail.messageId,
      references: [detail.references, detail.messageId].filter(Boolean).join(' ') || null,
    };
    navigate('/compose', { state: prefill });
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
        <button onClick={reply} className="rounded-full p-2 active:bg-surface-2" aria-label="Reply">
          <SendIcon className="text-fg" />
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
