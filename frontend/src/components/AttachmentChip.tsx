import { useState } from 'react';
import type { AttachmentDto } from '@maily/shared';
import { fetchAttachmentObjectUrl } from '../api/client';
import { Spinner } from '../ui/Spinner';
import { PaperclipIcon } from '../ui/icons';

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

/** Attachment chip. Bytes are fetched lazily on tap (§4) then opened in a new tab. */
export function AttachmentChip({
  messageId,
  attachment,
}: {
  messageId: string;
  attachment: AttachmentDto;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function open() {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const url = await fetchAttachmentObjectUrl(messageId, attachment.id);
      window.open(url, '_blank', 'noopener');
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={open}
      className="flex max-w-full items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-left transition active:bg-surface-2"
    >
      <span className="text-muted">
        {busy ? <Spinner className="size-4" /> : <PaperclipIcon className="size-4" />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm">{attachment.filename || 'attachment'}</span>
        <span className={`block text-xs ${error ? 'text-danger' : 'text-faint'}`}>
          {error ? 'Failed — tap to retry' : humanSize(attachment.sizeBytes)}
        </span>
      </span>
    </button>
  );
}
