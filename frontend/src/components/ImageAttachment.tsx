import { useEffect, useRef, useState } from 'react';
import type { AttachmentDto } from '@maily/shared';
import { fetchAttachmentBlob } from '../api/client';
import { isNativeAndroid } from '../nativeAndroid';
import { openAttachment, saveBlob } from '../ui/openAttachment';
import { Spinner } from '../ui/Spinner';
import { DownloadIcon, ShareIcon } from '../ui/icons';
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

/** True if this attachment is a previewable raster/vector image. */
export function isImageAttachment(a: AttachmentDto): boolean {
  return (a.mimeType ?? '').toLowerCase().startsWith('image/');
}

/** Auto-load previews up to this size; larger images wait for an explicit tap so opening
 * a message never silently pulls many MB (attachment bytes stay on-demand, ARCHITECTURE §4). */
const AUTOLOAD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Inline preview for a received image attachment, with Gmail-style quick actions:
 * a thumbnail (tap to open full-size), Share (native share sheet → SMS, mail, Photos,
 * … via the Web Share API where supported) and Download. Bytes are fetched lazily — on
 * mount for reasonably-sized images, otherwise on a "Show preview" tap — then reused for
 * the image, the share File and the download (one fetch, no re-download per action). The
 * Android shell is the exception: it fetches the file itself (see `openAttachment`).
 */
export function ImageAttachment({
  messageId,
  attachment,
}: {
  messageId: string;
  attachment: AttachmentDto;
}) {
  const online = useOnlineStatus();
  const [url, setUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const objectUrl = useRef<string | null>(null);
  const filename = attachment.filename || 'image';

  async function load() {
    if (!online || busy || objectUrl.current) return;
    setBusy(true);
    setError(false);
    try {
      const b = await fetchAttachmentBlob(messageId, attachment.id);
      const u = URL.createObjectURL(b);
      objectUrl.current = u;
      setBlob(b);
      setUrl(u);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (online && (attachment.sizeBytes ?? 0) <= AUTOLOAD_MAX_BYTES) void load();
    return () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
    // Mount-only: one ImageAttachment instance exists per attachment id (keyed in the list),
    // so the auto-load + object-URL cleanup runs once for this attachment's lifetime.
  }, []);

  // Routed through openAttachment so the Android shell gets its native path: a WebView
  // can save no `blob:`, which left the button below dead in the APK. Enabled before the
  // preview has loaded too — openAttachment fetches the bytes when we hold none.
  async function download() {
    if (!online) return;
    try {
      await openAttachment(messageId, attachment, blob);
    } catch {
      setError(true);
    }
  }

  // The Web Share API (mobile, installed PWA) opens the OS share sheet; if file sharing
  // isn't available we fall back to a plain download so the action always does something.
  const canShareFiles =
    typeof navigator !== 'undefined' && typeof navigator.canShare === 'function';
  async function share() {
    if (!blob) return;
    const file = new File([blob], filename, { type: attachment.mimeType || blob.type });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    } catch {
      // User cancelled, or the platform rejected the share — fall through to download.
    }
    saveBlob(blob, filename);
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener"
          onClick={(event) => {
            // The APK's WebView opens no popup window (see openAttachment), so the tap
            // would do nothing there; let Android open the image with a real app.
            if (!isNativeAndroid()) return;
            event.preventDefault();
            void download();
          }}
          className="block bg-surface-2"
        >
          <img
            src={url}
            alt={filename}
            className="mx-auto max-h-80 w-auto max-w-full object-contain"
          />
        </a>
      ) : (
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy || !online}
          className="flex min-h-24 w-full items-center justify-center gap-2 bg-surface-2 px-3 py-6 text-sm text-muted active:bg-surface-3 disabled:opacity-60"
        >
          {!online ? (
            <span>Preview unavailable offline</span>
          ) : busy ? (
            <Spinner className="size-4" />
          ) : error ? (
            <span className="text-danger">Couldn’t load — tap to retry</span>
          ) : (
            <span>Show preview</span>
          )}
        </button>
      )}
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{filename}</span>
          <span className="block text-xs text-faint">{humanSize(attachment.sizeBytes)}</span>
        </span>
        {canShareFiles && (
          <button
            type="button"
            onClick={() => void share()}
            disabled={!blob}
            aria-label="Share"
            title="Share"
            className="shrink-0 rounded-full p-2 text-muted active:bg-surface-2 active:text-accent disabled:opacity-40"
          >
            <ShareIcon className="size-5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => void download()}
          disabled={!online}
          aria-label="Download"
          title="Download"
          className="shrink-0 rounded-full p-2 text-muted active:bg-surface-2 active:text-accent disabled:opacity-40"
        >
          <DownloadIcon className="size-5" />
        </button>
      </div>
    </div>
  );
}
