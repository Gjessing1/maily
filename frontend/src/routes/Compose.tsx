import { useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { AttachmentRef, SendMessageRequest, UploadDto } from '@maily/shared';
import { api } from '../api/client';
import { useAccounts } from '../state/data';
import { usePrefs } from '../state/prefs';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { RichTextEditor } from '../components/RichTextEditor';
import { Spinner } from '../ui/Spinner';
import { cleanEditorHtml, htmlToPlainText, plainTextToHtml } from '../ui/htmlText';
import { BackIcon, PaperclipIcon, SendIcon } from '../ui/icons';

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
  inReplyTo?: string | null;
  references?: string | null;
  attachments?: ComposeAttachment[];
}

function parseAddrs(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Pragmatic address shape check — catches typos, not a full RFC 5322 validation. */
function isValidEmail(addr: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
}

/**
 * Compose the editor's starting HTML from a prefill: the user's typing line, the
 * signature (when enabled), then the quoted reply/forward text. Reply quotes are
 * plain text (`> …` prefixes) carried over from replyPrefill.ts.
 */
function buildInitialHtml(prefill: ComposePrefill, signature: string): string {
  const blocks = ['<div><br></div>'];
  if (signature) blocks.push(`<div>-- </div><div>${plainTextToHtml(signature)}</div>`);
  if (prefill.body?.trim()) blocks.push(`<div>${plainTextToHtml(prefill.body)}</div>`);
  return blocks.join('');
}

export function Compose() {
  const navigate = useNavigate();
  const prefill = (useLocation().state as ComposePrefill | null) ?? {};
  const accounts = useAccounts();
  const { signature, signatureEnabled } = usePrefs();

  const [accountId, setAccountId] = useState(prefill.accountId ?? '');
  const [to, setTo] = useState((prefill.to ?? []).join(', '));
  const [cc, setCc] = useState((prefill.cc ?? []).join(', '));
  const [showCc, setShowCc] = useState(Boolean(prefill.cc?.length));
  const [subject, setSubject] = useState(prefill.subject ?? '');

  // The editor is uncontrolled (seeded once with this HTML); `bodyHtml` tracks its
  // live content for sending and dirty-detection.
  const [initialHtml] = useState(() =>
    buildInitialHtml(prefill, signatureEnabled ? signature : ''),
  );
  const [bodyHtml, setBodyHtml] = useState(initialHtml);
  const [attachments, setAttachments] = useState<ComposeAttachment[]>(prefill.attachments ?? []);
  const [uploads, setUploads] = useState<UploadDto[]>([]);
  const [uploading, setUploading] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  function cancel() {
    if (isDirty) setConfirmDiscard(true);
    else navigate(-1);
  }

  /** Discard staged uploads server-side, then leave the composer. */
  function discardDraft() {
    setConfirmDiscard(false);
    for (const u of uploads) void api.deleteUpload(u.uploadId);
    navigate(-1);
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

  const canSend = Boolean(fromAccount && parseAddrs(to).length && !sending && uploading === 0);

  async function send() {
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
      inReplyTo: prefill.inReplyTo ?? null,
      references: prefill.references ?? null,
      attachments: attachments.length
        ? attachments.map(({ messageId, attachmentId }) => ({ messageId, attachmentId }))
        : undefined,
      uploads: uploads.length
        ? uploads.map(({ uploadId, filename, mimeType }) => ({ uploadId, filename, mimeType }))
        : undefined,
    };
    try {
      await api.send(fromAccount.id, msg);
      navigate(-1);
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
        <button
          onClick={() => fileInputRef.current?.click()}
          className="rounded-full p-2 active:bg-surface-2"
          aria-label="Attach files"
          type="button"
        >
          <PaperclipIcon />
        </button>
        <button
          onClick={send}
          disabled={!canSend}
          className="flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-medium text-white transition active:scale-95 disabled:opacity-40"
        >
          {sending ? (
            <Spinner className="border-white/70 size-4" />
          ) : (
            <SendIcon className="size-4" />
          )}
          Send
        </button>
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

        <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
          <span className="w-12 text-sm text-faint">To</span>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            inputMode="email"
            autoCapitalize="off"
            placeholder="recipient@example.com"
            className="flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
          />
          {!showCc && (
            <button onClick={() => setShowCc(true)} className="text-xs text-accent" type="button">
              Cc
            </button>
          )}
        </div>

        {showCc && (
          <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
            <span className="w-12 text-sm text-faint">Cc</span>
            <input
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              inputMode="email"
              autoCapitalize="off"
              className="flex-1 bg-transparent text-[15px] outline-none"
            />
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
          initialHtml={initialHtml}
          onChange={setBodyHtml}
          placeholder="Write your message…"
          className="min-h-[40vh] px-4 py-3"
        />
      </main>

      <ConfirmDialog
        open={confirmDiscard}
        title="Discard draft?"
        message="You’ve started a message. Discarding loses what you’ve written."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        danger
        onConfirm={discardDraft}
        onCancel={() => setConfirmDiscard(false)}
      />
    </div>
  );
}
