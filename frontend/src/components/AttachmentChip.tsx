import { useState } from 'react';
import type { AttachmentDto } from '@maily/shared';
import { openAttachment } from '../ui/openAttachment';
import { Spinner } from '../ui/Spinner';
import { PaperclipIcon } from '../ui/icons';
import { useOnlineStatus } from '../state/connectivity';

function humanSize(bytes: number | null): string {
  if (bytes == null) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

/**
 * Attachment chip. A tap hands the file to the platform: an app on Android, a new tab
 * in a desktop browser, a download on a phone (see `openAttachment`). Bytes are fetched
 * lazily, and only where the platform needs them from us (§4).
 */
export function AttachmentChip({
  messageId,
  attachment,
}: {
  messageId: string;
  attachment: AttachmentDto;
}) {
  const online = useOnlineStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function show() {
    if (busy || !online) return;
    setBusy(true);
    setError(false);
    try {
      await openAttachment(messageId, attachment);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={() => void show()}
      disabled={!online}
      className="flex max-w-full items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-left transition active:bg-surface-2 disabled:opacity-60"
    >
      <span className="text-muted">
        {busy ? <Spinner className="size-4" /> : <PaperclipIcon className="size-4" />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm">{attachment.filename || 'attachment'}</span>
        <span className={`block text-xs ${error ? 'text-danger' : 'text-faint'}`}>
          {!online
            ? 'Unavailable offline'
            : error
              ? 'Failed — tap to retry'
              : humanSize(attachment.sizeBytes)}
        </span>
      </span>
    </button>
  );
}
