import type { AttachmentDto } from '@maily/shared';
import { useAttachmentActions } from '../ui/useAttachmentActions';
import { Spinner } from '../ui/Spinner';
import { DownloadIcon, PaperclipIcon, ShareIcon } from '../ui/icons';

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

const ACTION =
  'flex shrink-0 items-center justify-center px-2.5 text-muted active:bg-surface-2 active:text-accent disabled:opacity-40';

/**
 * Attachment chip. Tapping the file opens it where the platform shows files best — an
 * app on Android, a new tab in a desktop browser, a download on a phone (see
 * `openAttachment`) — and the two buttons beside it Share it (the share sheet) or
 * Download it (to disk; the phone's Downloads in the Android app). Bytes are fetched
 * lazily, and only where the platform needs them from us (§4).
 */
export function AttachmentChip({
  messageId,
  attachment,
}: {
  messageId: string;
  attachment: AttachmentDto;
}) {
  const { online, busy, failed, canShare, open, share, download } = useAttachmentActions(
    messageId,
    attachment,
  );
  const name = attachment.filename || 'attachment';

  return (
    <div className="flex max-w-full items-stretch overflow-hidden rounded-xl border border-border bg-surface">
      <button
        type="button"
        onClick={() => void open()}
        disabled={!online}
        title={`Open ${name}`}
        className="flex min-w-0 items-center gap-2 px-3 py-2 text-left transition active:bg-surface-2 disabled:opacity-60"
      >
        <span className="text-muted">
          {busy === 'open' ? <Spinner className="size-4" /> : <PaperclipIcon className="size-4" />}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm">{name}</span>
          <span className={`block text-xs ${failed ? 'text-danger' : 'text-faint'}`}>
            {!online
              ? 'Unavailable offline'
              : failed
                ? 'Failed — tap to retry'
                : humanSize(attachment.sizeBytes)}
          </span>
        </span>
      </button>
      {canShare && (
        <button
          type="button"
          onClick={() => void share()}
          disabled={!online || busy !== null}
          aria-label={`Share ${name}`}
          title="Share"
          className={`${ACTION} border-l border-border`}
        >
          {busy === 'share' ? <Spinner className="size-4" /> : <ShareIcon className="size-4" />}
        </button>
      )}
      <button
        type="button"
        onClick={() => void download()}
        disabled={!online || busy !== null}
        aria-label={`Download ${name}`}
        title="Download"
        className={`${ACTION} border-l border-border`}
      >
        {busy === 'download' ? <Spinner className="size-4" /> : <DownloadIcon className="size-4" />}
      </button>
    </div>
  );
}
