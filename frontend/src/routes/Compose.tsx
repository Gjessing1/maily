import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { AttachmentRef, SendMessageRequest } from '@maily/shared';
import { api } from '../api/client';
import { useAccounts } from '../state/data';
import { Spinner } from '../ui/Spinner';
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

export function Compose() {
  const navigate = useNavigate();
  const prefill = (useLocation().state as ComposePrefill | null) ?? {};
  const accounts = useAccounts();

  const [accountId, setAccountId] = useState(prefill.accountId ?? '');
  const [to, setTo] = useState((prefill.to ?? []).join(', '));
  const [cc, setCc] = useState((prefill.cc ?? []).join(', '));
  const [showCc, setShowCc] = useState(Boolean(prefill.cc?.length));
  const [subject, setSubject] = useState(prefill.subject ?? '');
  const [body, setBody] = useState(prefill.body ?? '');
  const [attachments, setAttachments] = useState<ComposeAttachment[]>(prefill.attachments ?? []);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fromAccount = useMemo(
    () => accounts?.find((a) => a.id === accountId) ?? accounts?.[0],
    [accounts, accountId],
  );

  const canSend = Boolean(fromAccount && parseAddrs(to).length && !sending);

  async function send() {
    if (!fromAccount) return;
    const recipients = parseAddrs(to);
    if (!recipients.length) {
      setError('Add at least one recipient.');
      return;
    }
    setSending(true);
    setError(null);
    const msg: SendMessageRequest = {
      to: recipients,
      cc: showCc ? parseAddrs(cc) : undefined,
      subject,
      text: body,
      inReplyTo: prefill.inReplyTo ?? null,
      references: prefill.references ?? null,
      attachments: attachments.length
        ? attachments.map(({ messageId, attachmentId }) => ({ messageId, attachmentId }))
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
          onClick={() => navigate(-1)}
          className="rounded-full p-2 active:bg-surface-2"
          aria-label="Cancel"
        >
          <BackIcon />
        </button>
        <h1 className="flex-1 text-lg font-semibold">New message</h1>
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

        {attachments.length > 0 && (
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
          </div>
        )}

        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write your message…"
          className="min-h-[40vh] w-full resize-none bg-transparent px-4 py-3 text-[15px] leading-relaxed outline-none placeholder:text-faint"
        />
      </main>
    </div>
  );
}
