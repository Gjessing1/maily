import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { patchCachedFlags, removeCachedMessage } from '../db/cache';
import { useAccounts, useMessageDetail } from '../state/data';
import { usePrefs } from '../state/prefs';
import { hasRemoteImages, MailHtml, MailText } from '../components/MailBody';
import { AttachmentChip } from '../components/AttachmentChip';
import { Spinner } from '../ui/Spinner';
import {
  BackIcon,
  ForwardIcon,
  MailIcon,
  MailOpenIcon,
  ReplyAllIcon,
  ReplyIcon,
  StarIcon,
  TrashIcon,
} from '../ui/icons';
import { avatarHue, fullDate, initials, senderName } from '../ui/format';
import type { ComposeAttachment, ComposePrefill } from './Compose';

export function Reader() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { detail, loading, error } = useMessageDetail(id);
  const accounts = useAccounts();
  const { blockRemoteImages } = usePrefs();
  const [flagged, setFlagged] = useState(false);
  const [seen, setSeen] = useState(false);
  const [showImages, setShowImages] = useState(false);
  const autoMarkedId = useRef<string | null>(null);

  // Reflect server flag state once the detail loads; reset the per-message image
  // override so a newly opened message starts blocked again (when blocking is on).
  useEffect(() => {
    if (detail) {
      setFlagged(detail.flagged);
      setSeen(detail.seen);
    }
    setShowImages(false);
  }, [detail]);

  // Mark as read on first open (optimistic; server is authoritative). Evaluated
  // exactly once per opened message — keyed on the message id, NOT on the seen
  // flag. `detail` is re-emitted by Dexie on every cache write, so a manual
  // "mark unread" flips detail.seen back to false; gating on the id (instead of
  // re-checking detail.seen) stops that re-emit from re-marking the message read
  // and undoing the user's click.
  useEffect(() => {
    if (!detail || autoMarkedId.current === detail.id) return;
    autoMarkedId.current = detail.id;
    if (detail.seen) return; // already read on open — nothing to auto-mark
    setSeen(true);
    void patchCachedFlags(detail.id, { seen: true });
    api.setFlags(detail.id, { seen: true }).catch(() => undefined);
  }, [detail]);

  async function toggleSeen() {
    if (!detail) return;
    const next = !seen;
    setSeen(next);
    void patchCachedFlags(detail.id, { seen: next });
    try {
      await api.setFlags(detail.id, { seen: next });
    } catch {
      setSeen(!next); // revert on failure
      void patchCachedFlags(detail.id, { seen: !next });
    }
  }

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
  const allowImages = !blockRemoteImages || showImages;
  const imagesBlocked =
    blockRemoteImages &&
    !showImages &&
    Boolean(detail?.bodyHtml && hasRemoteImages(detail.bodyHtml));

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
          onClick={toggleSeen}
          className="rounded-full p-2 active:bg-surface-2"
          aria-label={seen ? 'Mark as unread' : 'Mark as read'}
        >
          {seen ? <MailIcon className="text-fg" /> : <MailOpenIcon className="text-accent" />}
        </button>
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
              {imagesBlocked && (
                <div className="flex items-center justify-between gap-3 bg-surface px-4 py-2 text-sm">
                  <span className="text-muted">Remote images blocked for privacy.</span>
                  <button
                    onClick={() => setShowImages(true)}
                    className="shrink-0 font-medium text-accent active:opacity-70"
                  >
                    Show images
                  </button>
                </div>
              )}
              {detail.bodyHtml ? (
                <MailHtml html={detail.bodyHtml} allowImages={allowImages} />
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
