import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { AttachmentRef, SaveDraftRequest, SendMessageRequest, UploadDto } from '@maily/shared';
import { api } from '../api/client';
import { deleteDraft, getDraft, saveDraft } from '../db/cache';
import { useAccounts } from '../state/data';
import { getPrefs, usePrefs } from '../state/prefs';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { RecipientInput } from '../components/RecipientInput';
import { RichTextEditor } from '../components/RichTextEditor';
import { Spinner } from '../ui/Spinner';
import { cleanEditorHtml, htmlToPlainText, plainTextToHtml } from '../ui/htmlText';
import { BackIcon, ClockIcon, NewWindowIcon, PaperclipIcon, SendIcon } from '../ui/icons';
import {
  claimPopoutName,
  closePopout,
  isPopout,
  openPopout,
  postToWindows,
  putHandoff,
  takeHandoff,
  usePopoutCapable,
} from '../ui/popout';
import { showNotice, stageSend } from '../state/undo';

/** Human-readable label for a scheduled-send time (confirmation notice). */
function formatSchedule(ms: number): string {
  return new Date(ms).toLocaleString([], {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  });
}

/** `datetime-local` value (local time, no tz suffix) for a Date — used to seed the picker. */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** sessionStorage key holding the id of the compose draft in progress (for reload restore). */
const ACTIVE_DRAFT_KEY = 'maily.activeDraft';

/** A forwarded attachment carried into compose: the send ref plus a name for display. */
export interface ComposeAttachment extends AttachmentRef {
  filename: string | null;
}

/** Prefill passed via router state (e.g. from the Reader's reply/forward actions). */
export interface ComposePrefill {
  accountId?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  body?: string;
  /** Raw HTML to seed the editor verbatim (used when editing an existing draft). */
  bodyHtml?: string;
  inReplyTo?: string | null;
  references?: string | null;
  attachments?: ComposeAttachment[];
  /** Internal id of the \Drafts message being edited; removed on save/send. */
  sourceDraftId?: string;
  /** Files already staged server-side — carried when a compose is detached into its own window. */
  uploads?: UploadDto[];
}

function parseAddrs(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Extract the bare address from a `Name <email>` token (autocomplete inserts these). */
function addrEmail(token: string): string {
  const m = /<([^>]+)>/.exec(token);
  return (m?.[1] ?? token).trim();
}

/** Pragmatic address shape check — catches typos, not a full RFC 5322 validation. */
function isValidEmail(addr: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addrEmail(addr));
}

/**
 * Compose the editor's starting HTML from a prefill: the user's typing line, the
 * signature (when enabled), then the quoted reply/forward text. Reply quotes are
 * plain text (`> …` prefixes) carried over from replyPrefill.ts.
 */
function buildInitialHtml(prefill: ComposePrefill, signature: string): string {
  // Editing an existing draft: seed the editor with its exact HTML — no signature
  // injection or re-quoting, the draft already holds whatever the user wrote.
  if (prefill.bodyHtml != null) return prefill.bodyHtml;
  const blocks = ['<div><br></div>'];
  if (signature) blocks.push(`<div>-- </div><div>${plainTextToHtml(signature)}</div>`);
  if (prefill.body?.trim()) blocks.push(`<div>${plainTextToHtml(prefill.body)}</div>`);
  return blocks.join('');
}

export function Compose() {
  const navigate = useNavigate();
  // `fresh` marks a brand-new compose navigation (reply/forward/new). A reload of an
  // in-progress compose loses it (we clear it after consuming), so we restore the
  // autosaved draft instead — see the effects below.
  const routerState = useLocation().state as (ComposePrefill & { fresh?: boolean }) | null;
  // A detached composer can't receive router state through `window.open`, so its prefill
  // is parked in localStorage and picked up here (once) via `?handoff=`. The `fresh` effect
  // below re-parks it in history state, so reloading the popout still restores it.
  const [searchParams] = useSearchParams();
  const [handoff] = useState(() => takeHandoff<ComposePrefill>(searchParams.get('handoff')));
  const stateObj = handoff ? { ...handoff, fresh: true } : routerState;
  const isFresh = Boolean(stateObj?.fresh);
  const prefill = stateObj ?? {};
  // Detached-window affordance: desktop only, and hidden inside a popout (already detached).
  const popout = isPopout();
  const canPopout = usePopoutCapable() && !popout;
  // Set once the composer is intentionally leaving (sent/saved/discarded/detached) so the
  // unsaved-work guard below doesn't challenge our own close.
  const leaving = useRef(false);
  /** Leave the composer: back to where we came from, or close the detached window. */
  function leave() {
    leaving.current = true;
    if (popout) closePopout();
    else navigate(-1);
  }
  const accounts = useAccounts();
  const { signature, signatureEnabled } = usePrefs();

  // Stable draft id for this compose session: a fresh navigation mints a new one;
  // a reload reuses the one parked in sessionStorage so the draft can be restored.
  const [draftId] = useState(() => {
    const existing = sessionStorage.getItem(ACTIVE_DRAFT_KEY);
    if (isFresh || !existing) {
      const id = crypto.randomUUID();
      sessionStorage.setItem(ACTIVE_DRAFT_KEY, id);
      return id;
    }
    return existing;
  });

  // A reply/forward carries its source account; a fresh compose falls back to the
  // user's configured default account ('' → automatic, resolved to the first account
  // by `fromAccount` below).
  const [accountId, setAccountId] = useState(
    prefill.accountId ?? getPrefs().defaultComposeAccountId,
  );
  const [to, setTo] = useState((prefill.to ?? []).join(', '));
  const [cc, setCc] = useState((prefill.cc ?? []).join(', '));
  const [showCc, setShowCc] = useState(Boolean(prefill.cc?.length));
  const [subject, setSubject] = useState(prefill.subject ?? '');
  const [inReplyTo, setInReplyTo] = useState(prefill.inReplyTo ?? null);
  const [references, setReferences] = useState(prefill.references ?? null);
  // The \Drafts message this compose edits, if any — superseded (removed) on save/send.
  const [sourceDraftId] = useState(prefill.sourceDraftId);

  // The editor is uncontrolled; `initialHtml` is the dirty-detection baseline, while
  // `editorSeed`/`seedKey` reseed the editor's DOM on a draft restore.
  const [initialHtml] = useState(() =>
    buildInitialHtml(prefill, signatureEnabled ? signature : ''),
  );
  const [editorSeed, setEditorSeed] = useState(initialHtml);
  const [seedKey, setSeedKey] = useState(0);
  const [bodyHtml, setBodyHtml] = useState(initialHtml);
  const [attachments, setAttachments] = useState<ComposeAttachment[]>(prefill.attachments ?? []);
  const [uploads, setUploads] = useState<UploadDto[]>(prefill.uploads ?? []);
  const [uploading, setUploading] = useState(0);
  const [sending, setSending] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // On a fresh navigation, strip the `fresh` flag from history state so a subsequent
  // reload falls through to the restore path instead of re-seeding from the prefill.
  useEffect(() => {
    if (isFresh) {
      const rest = { ...stateObj } as Record<string, unknown>;
      delete rest.fresh;
      navigate('.', { replace: true, state: rest });
    }
  }, []);

  // Restore an autosaved draft after a reload (non-fresh mount with a saved record).
  useEffect(() => {
    if (isFresh) return;
    let alive = true;
    void getDraft(draftId).then((d) => {
      if (!alive || !d) return;
      setAccountId(d.accountId ?? '');
      setTo(d.to);
      setCc(d.cc);
      setShowCc(d.showCc);
      setSubject(d.subject);
      setInReplyTo(d.inReplyTo);
      setReferences(d.references);
      setAttachments(d.attachments);
      setUploads(d.uploads);
      setBodyHtml(d.bodyHtml);
      setEditorSeed(d.bodyHtml);
      setSeedKey((k) => k + 1);
    });
    return () => {
      alive = false;
    };
  }, []);

  // "Dirty" = the user changed something relative to the prefill (reply/forward
  // quotes + signature don't count as user input, so an untouched draft discards
  // silently). Body comparison is on rendered text so whitespace-only edits don't count.
  const isDirty =
    to !== (prefill.to ?? []).join(', ') ||
    (showCc && cc !== (prefill.cc ?? []).join(', ')) ||
    subject !== (prefill.subject ?? '') ||
    htmlToPlainText(bodyHtml) !== htmlToPlainText(initialHtml) ||
    uploads.length > 0 ||
    attachments.length !== (prefill.attachments?.length ?? 0);

  // Local-first autosave (ROADMAP §3.7.B): persist an in-progress draft to IndexedDB
  // (debounced) so it survives a reload/refresh. Untouched composes aren't saved.
  useEffect(() => {
    if (!isDirty) return;
    const t = setTimeout(() => {
      void saveDraft({
        id: draftId,
        accountId,
        to,
        cc,
        showCc,
        subject,
        bodyHtml,
        inReplyTo,
        references,
        attachments,
        uploads,
        updatedAt: Date.now(),
      });
    }, 600);
    return () => clearTimeout(t);
  }, [
    isDirty,
    draftId,
    accountId,
    to,
    cc,
    showCc,
    subject,
    bodyHtml,
    inReplyTo,
    references,
    attachments,
    uploads,
  ]);

  // Name a detached composer after what's being written — the title bar is the only
  // label a popout window has.
  useEffect(() => {
    if (!popout) return;
    document.title = subject.trim() || 'New message';
  }, [popout, subject]);

  // Take over this popout's identity (it may have opened as a reader before Reply was
  // pressed) so re-opening that message elsewhere can't navigate this draft away.
  useEffect(() => {
    if (popout) claimPopoutName(`compose:${draftId}`);
  }, [popout, draftId]);

  // Closing a detached composer bypasses the discard dialog (the window chrome's ✕ is
  // outside the app), and its autosave dies with the window's sessionStorage — so warn.
  useEffect(() => {
    if (!popout || !isDirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      if (!leaving.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [popout, isDirty]);

  /** Forget the persisted draft for this compose session. */
  function clearDraft() {
    sessionStorage.removeItem(ACTIVE_DRAFT_KEY);
    void deleteDraft(draftId);
  }

  /**
   * Move this in-progress compose into its own window: hand the current state over
   * (including staged uploads, which move by reference — they must NOT be deleted here),
   * drop the local autosave so the two windows can't both own it, and leave.
   * A blocked popup leaves the composer exactly as it was.
   */
  function detach() {
    const seed: ComposePrefill = {
      accountId,
      to: parseAddrs(to),
      cc: showCc ? parseAddrs(cc) : undefined,
      subject,
      bodyHtml,
      inReplyTo,
      references,
      attachments,
      uploads,
      sourceDraftId,
    };
    const handoffId = putHandoff(seed);
    if (!handoffId) {
      setError('Could not open a new window.');
      return;
    }
    if (!openPopout(`/compose?handoff=${handoffId}`, `compose:${draftId}`)) {
      setError('Your browser blocked the new window — allow pop-ups for this site.');
      return;
    }
    clearDraft();
    leave();
  }

  function cancel() {
    if (isDirty) setConfirmDiscard(true);
    else {
      clearDraft();
      leave();
    }
  }

  /** Discard staged uploads + the persisted draft, then leave the composer. */
  function discardDraft() {
    setConfirmDiscard(false);
    for (const u of uploads) void api.deleteUpload(u.uploadId);
    clearDraft();
    leave();
  }

  /**
   * Save the in-progress message to the account's \Drafts mailbox (syncs across
   * devices), drop the local autosave, and leave. Recipients are optional for a
   * draft. Editing an existing draft passes `replaceDraftId` so the old copy is
   * removed rather than duplicated.
   */
  async function saveDraftToServer() {
    setConfirmDiscard(false);
    if (!fromAccount) {
      clearDraft();
      leave();
      return;
    }
    setSavingDraft(true);
    setError(null);
    const html = cleanEditorHtml(bodyHtml);
    const ccList = showCc ? parseAddrs(cc) : [];
    const msg: SaveDraftRequest = {
      to: parseAddrs(to),
      cc: ccList.length ? ccList : undefined,
      subject,
      text: htmlToPlainText(bodyHtml),
      html: html || undefined,
      inReplyTo,
      references,
      attachments: attachments.length
        ? attachments.map(({ messageId, attachmentId }) => ({ messageId, attachmentId }))
        : undefined,
      uploads: uploads.length
        ? uploads.map(({ uploadId, filename, mimeType }) => ({ uploadId, filename, mimeType }))
        : undefined,
      replaceDraftId: sourceDraftId,
    };
    try {
      await api.saveDraft(fromAccount.id, msg);
      clearDraft();
      leave();
    } catch (e) {
      setError((e as Error).message || 'Could not save draft.');
      setSavingDraft(false);
    }
  }

  async function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // allow re-picking the same file
    for (const file of files) {
      setUploading((n) => n + 1);
      try {
        const dto = await api.uploadAttachment(file);
        setUploads((prev) => [...prev, dto]);
      } catch (err) {
        setError((err as Error).message || `Couldn't upload ${file.name}.`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  function removeUpload(uploadId: string) {
    setUploads((prev) => prev.filter((u) => u.uploadId !== uploadId));
    void api.deleteUpload(uploadId);
  }

  const fromAccount = useMemo(
    () => accounts?.find((a) => a.id === accountId) ?? accounts?.[0],
    [accounts, accountId],
  );

  const canSend = Boolean(
    fromAccount && parseAddrs(to).length && !sending && !savingDraft && uploading === 0,
  );

  /**
   * Queue the message. With no `sendAt` it's held for the configured undo-send window and the
   * "Undo send" snackbar is armed; with a future `sendAt` it's scheduled (a confirmation notice,
   * no snackbar). Either way the backend outbox owns the actual send, so it goes out even if the
   * app closes.
   */
  async function send(sendAt?: number) {
    if (!fromAccount) return;
    const recipients = parseAddrs(to);
    if (!recipients.length) {
      setError('Add at least one recipient.');
      return;
    }
    const ccList = showCc ? parseAddrs(cc) : [];
    const bad = [...recipients, ...ccList].filter((a) => !isValidEmail(a));
    if (bad.length) {
      setError(`Check these addresses: ${bad.join(', ')}`);
      return;
    }
    const scheduled = typeof sendAt === 'number' && sendAt > Date.now();
    // Empty subject is allowed, but confirm — it's almost always an oversight.
    if (!subject.trim() && !window.confirm('Send this message without a subject?')) {
      return;
    }
    setSending(true);
    setError(null);
    const html = cleanEditorHtml(bodyHtml);
    const text = htmlToPlainText(bodyHtml);
    const msg: SendMessageRequest = {
      to: recipients,
      cc: ccList.length ? ccList : undefined,
      subject,
      text,
      html: html || undefined,
      inReplyTo,
      references,
      attachments: attachments.length
        ? attachments.map(({ messageId, attachmentId }) => ({ messageId, attachmentId }))
        : undefined,
      uploads: uploads.length
        ? uploads.map(({ uploadId, filename, mimeType }) => ({ uploadId, filename, mimeType }))
        : undefined,
      replaceDraftId: sourceDraftId,
      sendAt: scheduled ? sendAt : undefined,
    };
    try {
      const { outboxId, dueAt } = await api.send(fromAccount.id, msg);
      clearDraft();
      // A detached composer closes the moment it sends, taking its own snackbar with it —
      // hand the undo window (or the confirmation) to the main window instead.
      if (scheduled) {
        const message = `Scheduled for ${formatSchedule(dueAt)}`;
        if (popout) postToWindows({ type: 'notice', message });
        else showNotice(message);
      } else if (popout) {
        postToWindows({ type: 'staged-send', outboxId, dueAt });
      } else {
        // Arm the "Undo send" snackbar until the server's dueAt (the undo window end).
        void stageSend(outboxId, dueAt);
      }
      leave();
    } catch (e) {
      setError((e as Error).message || 'Send failed.');
      setSending(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-bg/85 px-2 py-2 backdrop-blur">
        <button
          onClick={cancel}
          className="rounded-full p-2 active:bg-surface-2"
          aria-label="Cancel"
        >
          <BackIcon />
        </button>
        <h1 className="flex-1 text-lg font-semibold">New message</h1>
        <input ref={fileInputRef} type="file" multiple onChange={onPickFiles} className="hidden" />
        {/* Detach the composer so the rest of the mailbox stays browsable while writing. */}
        {canPopout && (
          <button
            onClick={detach}
            className="rounded-full p-2 active:bg-surface-2"
            aria-label="Open in new window"
            title="Open in new window"
            type="button"
          >
            <NewWindowIcon />
          </button>
        )}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="rounded-full p-2 active:bg-surface-2"
          aria-label="Attach files"
          type="button"
        >
          <PaperclipIcon />
        </button>
        <div className="relative flex items-center">
          <button
            onClick={() => void send()}
            disabled={!canSend}
            className="flex items-center gap-2 rounded-l-full bg-accent px-4 py-2 text-sm font-medium text-white transition active:scale-95 disabled:opacity-40"
          >
            {sending ? (
              <Spinner className="border-white/70 size-4" />
            ) : (
              <SendIcon className="size-4" />
            )}
            Send
          </button>
          <button
            type="button"
            onClick={() => {
              setScheduleAt((v) => v || toLocalInputValue(new Date(Date.now() + 60 * 60 * 1000)));
              setScheduleOpen((o) => !o);
            }}
            disabled={!canSend}
            aria-label="Send later"
            className="flex items-center rounded-r-full border-l border-white/25 bg-accent px-2 py-2 text-white transition active:scale-95 disabled:opacity-40"
          >
            <ClockIcon className="size-4" />
          </button>
          {scheduleOpen && (
            <div className="absolute right-0 top-full z-20 mt-2 w-72 rounded-xl border border-border bg-surface-2 p-3 shadow-lg">
              <p className="mb-2 text-sm font-medium text-fg">Send later</p>
              <input
                type="datetime-local"
                value={scheduleAt}
                min={toLocalInputValue(new Date(Date.now() + 60 * 1000))}
                onChange={(e) => setScheduleAt(e.target.value)}
                className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-sm outline-none"
              />
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setScheduleOpen(false)}
                  className="rounded-full px-3 py-1.5 text-sm text-faint active:bg-surface-3"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const ms = new Date(scheduleAt).getTime();
                    if (!Number.isFinite(ms) || ms <= Date.now()) {
                      setError('Pick a time in the future.');
                      return;
                    }
                    setScheduleOpen(false);
                    void send(ms);
                  }}
                  className="rounded-full bg-accent px-3 py-1.5 text-sm font-medium text-white active:scale-95"
                >
                  Schedule
                </button>
              </div>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 overflow-y-auto no-scrollbar">
        {error && <p className="px-4 pt-3 text-sm text-danger">{error}</p>}

        {(accounts?.length ?? 0) > 1 && (
          <label className="flex items-center gap-3 border-b border-border px-4 py-2.5">
            <span className="w-12 text-sm text-faint">From</span>
            <select
              value={fromAccount?.id ?? ''}
              onChange={(e) => setAccountId(e.target.value)}
              className="flex-1 bg-transparent text-[15px] outline-none"
            >
              {accounts?.map((a) => (
                <option key={a.id} value={a.id} className="bg-surface">
                  {a.displayName || a.email}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="flex items-start gap-3 border-b border-border px-4 py-2.5">
          <span className="w-12 pt-1 text-sm text-faint">To</span>
          <RecipientInput
            value={to}
            onChange={setTo}
            ariaLabel="To"
            placeholder="recipient@example.com"
          />
          {!showCc && (
            <button
              onClick={() => setShowCc(true)}
              className="pt-1 text-xs text-accent"
              type="button"
            >
              Cc
            </button>
          )}
        </div>

        {showCc && (
          <div className="flex items-start gap-3 border-b border-border px-4 py-2.5">
            <span className="w-12 pt-1 text-sm text-faint">Cc</span>
            <RecipientInput value={cc} onChange={setCc} ariaLabel="Cc" />
          </div>
        )}

        <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
          <span className="w-12 text-sm text-faint">Subject</span>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="flex-1 bg-transparent text-[15px] outline-none"
          />
        </div>

        {(attachments.length > 0 || uploads.length > 0 || uploading > 0) && (
          <div className="flex flex-wrap gap-2 border-b border-border px-4 py-2.5">
            {attachments.map((a) => (
              <span
                key={a.attachmentId}
                className="flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 text-xs"
              >
                <PaperclipIcon className="size-3.5 text-faint" />
                <span className="max-w-[40vw] truncate">{a.filename || 'attachment'}</span>
                <button
                  type="button"
                  onClick={() =>
                    setAttachments((prev) => prev.filter((x) => x.attachmentId !== a.attachmentId))
                  }
                  className="text-faint active:text-fg"
                  aria-label="Remove attachment"
                >
                  ✕
                </button>
              </span>
            ))}
            {uploads.map((u) => (
              <span
                key={u.uploadId}
                className="flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 text-xs"
              >
                <PaperclipIcon className="size-3.5 text-faint" />
                <span className="max-w-[40vw] truncate">{u.filename}</span>
                <button
                  type="button"
                  onClick={() => removeUpload(u.uploadId)}
                  className="text-faint active:text-fg"
                  aria-label="Remove attachment"
                >
                  ✕
                </button>
              </span>
            ))}
            {uploading > 0 && (
              <span className="flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 text-xs text-faint">
                <Spinner className="size-3.5" />
                Uploading…
              </span>
            )}
          </div>
        )}

        <RichTextEditor
          initialHtml={editorSeed}
          resetKey={seedKey}
          onChange={setBodyHtml}
          placeholder="Write your message…"
          className="min-h-[40vh] px-4 py-3"
        />
      </main>

      <ConfirmDialog
        open={confirmDiscard}
        title="Save this draft?"
        message="Save it to your Drafts folder (available on all your devices), or discard what you’ve written."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        neutralLabel="Save draft"
        danger
        onConfirm={discardDraft}
        onNeutral={() => void saveDraftToServer()}
        onCancel={() => setConfirmDiscard(false)}
      />
    </div>
  );
}
