import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { patchCachedFlags, removeCachedMessage } from '../db/cache';
import { requestDelete } from '../state/undo';
import { useAccounts, useFolders, useMessageDetail } from '../state/data';
import { usePrefs } from '../state/prefs';
import { plainTextToHtml } from '../ui/htmlText';
import { hasRemoteImages, MailHtml, MailText } from '../components/MailBody';
import { AttachmentChip } from '../components/AttachmentChip';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Spinner } from '../ui/Spinner';
import {
  ArchiveIcon,
  BackIcon,
  ChevronDownIcon,
  ForwardIcon,
  MailIcon,
  MailOpenIcon,
  PencilIcon,
  ReplyAllIcon,
  ReplyIcon,
  StarIcon,
  TrashIcon,
} from '../ui/icons';
import type { EmailAddress } from '@maily/shared';
import { avatarHue, fullDate, initials, senderName } from '../ui/format';
import { buildForward, buildReply, buildReplyAll } from '../state/replyPrefill';

/** One label/value row in the expanded message-header block. */
function HeaderField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-12 shrink-0 text-faint">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-fg">{value}</dd>
    </div>
  );
}

/**
 * Message reader body. Driven by an explicit `id` + `onClose` so it works both as
 * the full-screen `/m/:id` route (below) and embedded in Home's split reading pane.
 * `embedded` hides the redundant back button when shown beside the list.
 */
export function ReaderView({
  id,
  onClose,
  embedded = false,
}: {
  id: string | undefined;
  onClose: () => void;
  embedded?: boolean;
}) {
  const navigate = useNavigate();
  const { detail, loading, error } = useMessageDetail(id);
  const accounts = useAccounts();
  const { blockRemoteImages, markReadSeconds } = usePrefs();
  const [flagged, setFlagged] = useState(false);
  const [seen, setSeen] = useState(false);
  const [showImages, setShowImages] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const autoMarkedId = useRef<string | null>(null);

  // Reflect server flag state once the detail loads; reset the per-message image
  // override so a newly opened message starts blocked again (when blocking is on).
  useEffect(() => {
    if (detail) {
      setFlagged(detail.flagged);
      setSeen(detail.seen);
    }
    setShowImages(false);
    setDetailsOpen(false);
  }, [detail]);

  // Auto-mark as read on open (optimistic; server is authoritative), honouring the
  // `markReadSeconds` pref: `-1` never, `0` immediately, `>0` after a dwell timer.
  // Evaluated exactly once per opened message — keyed on the message id, NOT on the
  // seen flag. `detail` is re-emitted by Dexie on every cache write, so a manual
  // "mark unread" flips detail.seen back to false; gating on the id (instead of
  // re-checking detail.seen) stops that re-emit from re-marking the message read and
  // undoing the user's click. The dwell timer is cleared on unmount/navigation (and
  // by a manual toggle, which writes flags → re-emit → effect cleanup), so leaving
  // the message before the delay elapses leaves it unread.
  // Keyed on primitives (id + seen), NOT the `detail` object: the body refetch on
  // open re-caches the row and emits a fresh `detail` reference, and gating the
  // dwell timer on that would clear it before it fires. id/seen only change on a
  // real flag write, so the timer survives the background refetch.
  const detailId = detail?.id;
  const detailSeen = detail?.seen;
  useEffect(() => {
    if (!detailId || autoMarkedId.current === detailId) return;
    autoMarkedId.current = detailId;
    if (detailSeen) return; // already read on open — nothing to auto-mark
    if (markReadSeconds < 0) return; // "never"

    const mark = () => {
      setSeen(true);
      void patchCachedFlags(detailId, { seen: true });
      api.setFlags(detailId, { seen: true }).catch(() => undefined);
    };
    if (markReadSeconds === 0) {
      mark();
      return;
    }
    const timer = setTimeout(mark, markReadSeconds * 1000);
    return () => clearTimeout(timer);
  }, [detailId, detailSeen, markReadSeconds]);

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

  function reply() {
    if (!detail) return;
    navigate('/compose', { state: { ...buildReply(detail), fresh: true } });
  }

  function replyAll() {
    if (!detail) return;
    navigate('/compose', { state: { ...buildReplyAll(detail, accounts ?? []), fresh: true } });
  }

  function remove() {
    if (!detail) return;
    // Stage with an undo window (app-level snackbar persists past this navigation),
    // then leave the reader. The Trash move commits server-side once it elapses.
    void requestDelete(detail.id);
    onClose();
  }

  function archive() {
    if (!detail) return;
    // Optimistic: drop locally + leave; the server moves the inbox copy to Archive
    // out-of-band (non-destructive, no confirm). Re-syncs into Archive when viewed.
    void removeCachedMessage(detail.id);
    onClose();
    api.archiveMessage(detail.id).catch(() => undefined);
  }

  function forward() {
    if (!detail) return;
    navigate('/compose', { state: { ...buildForward(detail), fresh: true } });
  }

  /** Reopen a saved draft in the composer; saving/sending supersedes this copy. */
  function editDraft() {
    if (!detail) return;
    const toAddr = (a: EmailAddress): string =>
      a.name?.trim() ? `${a.name.trim()} <${a.address}>` : a.address;
    navigate('/compose', {
      state: {
        fresh: true,
        accountId: detail.accountId,
        to: detail.to.map(toAddr),
        cc: detail.cc.length ? detail.cc.map(toAddr) : undefined,
        subject: detail.subject ?? undefined,
        // Seed the editor verbatim — prefer stored HTML, else wrap the plain text.
        bodyHtml: detail.bodyHtml ?? plainTextToHtml(detail.bodyText ?? ''),
        inReplyTo: detail.inReplyTo,
        references: detail.references,
        sourceDraftId: detail.id,
      },
    });
  }

  const fmtAddr = (a: EmailAddress): string =>
    a.name?.trim() ? `${a.name.trim()} <${a.address}>` : a.address;
  const joinAddrs = (list: EmailAddress[]): string => list.map(fmtAddr).join(', ');

  // A message that lives in a \Drafts folder is editable rather than repliable.
  const folders = useFolders(detail?.accountId);
  const isDraft = Boolean(
    detail && folders?.some((f) => f.role === 'drafts' && detail.folderIds.includes(f.id)),
  );

  const hue = detail ? avatarHue(detail.fromAddress ?? detail.id) : 0;
  const visibleAttachments = detail?.attachments.filter((a) => !a.isInline) ?? [];
  const allowImages = !blockRemoteImages || showImages;
  const imagesBlocked =
    blockRemoteImages &&
    !showImages &&
    Boolean(detail?.bodyHtml && hasRemoteImages(detail.bodyHtml));

  // Embedded split pane with nothing selected yet → invitation placeholder.
  if (embedded && !id) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-faint">
        Select a message to read it here.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top sticky top-0 z-10 flex items-center gap-1 border-b border-border bg-bg/85 px-2 py-2 backdrop-blur">
        {!embedded && (
          <button
            onClick={onClose}
            className="rounded-full p-2 active:bg-surface-2"
            aria-label="Back"
          >
            <BackIcon />
          </button>
        )}
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
          onClick={archive}
          className="rounded-full p-2 active:bg-surface-2"
          aria-label="Archive"
        >
          <ArchiveIcon className="text-fg" />
        </button>
        <button
          onClick={() => setConfirmDelete(true)}
          className="rounded-full p-2 active:bg-surface-2"
          aria-label="Delete"
        >
          <TrashIcon className="text-fg" />
        </button>
        {isDraft ? (
          <button
            onClick={editDraft}
            className="rounded-full p-2 active:bg-surface-2"
            aria-label="Edit draft"
          >
            <PencilIcon className="text-accent" />
          </button>
        ) : (
          <>
            <button
              onClick={reply}
              className="rounded-full p-2 active:bg-surface-2"
              aria-label="Reply"
            >
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
          </>
        )}
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
              <button
                onClick={() => setDetailsOpen((o) => !o)}
                aria-expanded={detailsOpen}
                className="mt-3 flex w-full items-center gap-3 text-left"
              >
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
                    {detail.to.length ? `to ${joinAddrs(detail.to)}` : ''}
                    {detail.to.length ? ' · ' : ''}
                    {fullDate(detail.sentAt ?? detail.receivedAt)}
                  </p>
                </div>
                <ChevronDownIcon
                  className={`size-4 shrink-0 text-faint transition-transform ${detailsOpen ? 'rotate-180' : ''}`}
                />
              </button>

              {detailsOpen && (
                <dl className="mt-3 space-y-1.5 rounded-lg bg-surface px-3 py-2.5 text-xs">
                  <HeaderField
                    label="From"
                    value={fmtAddr({ name: detail.fromName, address: detail.fromAddress ?? '' })}
                  />
                  {detail.to.length > 0 && <HeaderField label="To" value={joinAddrs(detail.to)} />}
                  {detail.cc.length > 0 && <HeaderField label="Cc" value={joinAddrs(detail.cc)} />}
                  <HeaderField label="Date" value={fullDate(detail.sentAt ?? detail.receivedAt)} />
                  {detail.subject && <HeaderField label="Subject" value={detail.subject} />}
                </dl>
              )}
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

      <ConfirmDialog
        open={confirmDelete}
        title="Delete message?"
        message="This moves the message to Trash. You can restore it from there until it’s permanently removed."
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          setConfirmDelete(false);
          void remove();
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

/** Full-screen `/m/:id` route: reads the id from the URL; back returns to the list. */
export function Reader() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  return <ReaderView id={id} onClose={() => navigate(-1)} />;
}
