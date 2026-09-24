import { useEffect, useRef, useState } from 'react';
import type { AttachmentDto } from '@maily/shared';
import { fetchAttachmentBlob } from '../api/client';
import { isNativeAndroid } from '../nativeAndroid';
import { imageTabUrl } from '../ui/openAttachment';
import { useAttachmentActions } from '../ui/useAttachmentActions';
import { Spinner } from '../ui/Spinner';
import { DownloadIcon, NewWindowIcon, ShareIcon } from '../ui/icons';

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

const ACTION =
  'shrink-0 rounded-full p-2 text-muted active:bg-surface-2 active:text-accent disabled:opacity-40';

/**
 * Inline preview for a received image attachment. Tapping the image opens it full-size
 * where the platform shows images best — a browser tab on the web, the phone's own
 * viewer (Photos, Gallery, …) in the Android app — and the row below offers the explicit
 * choices: Open, Share (the share sheet → Messages, Drive, a chat…) and Download (to disk;
 * the phone's Downloads in the Android app).
 *
 * The two shells get there differently, which `ui/openAttachment` hides: a browser reuses
 * the bytes fetched for the preview (one fetch, no re-download per action), while the
 * Android shell fetches the file natively, since a WebView can neither open a popup nor
 * save or share a `blob:`. Bytes are fetched lazily — on mount for reasonably-sized
 * images, otherwise on a "Show preview" tap.
 */
export function ImageAttachment({
  messageId,
  attachment,
}: {
  messageId: string;
  attachment: AttachmentDto;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const actions = useAttachmentActions(messageId, attachment, blob);
  const { online, canShare } = actions;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const objectUrl = useRef<string | null>(null);
  const filename = attachment.filename || 'image';
  const native = isNativeAndroid();

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

  /** Where a browser tab should go to show the image; null in the Android app. */
  const tabUrl = native ? null : imageTabUrl(messageId, attachment, url);

  /**
   * Open full-size. In a browser this is a synchronous `window.open` inside the click, so
   * no popup blocker objects; when no tab URL exists yet (in-app login, preview not
   * loaded) it falls back to the general attachment handling, which downloads.
   */
  function openFull() {
    if (tabUrl) {
      // Not the `noopener` feature: with it, `window.open` returns null even on success,
      // which is indistinguishable from a blocked popup.
      const tab = window.open(tabUrl, '_blank');
      if (tab) {
        tab.opener = null;
        return;
      }
    }
    void actions.open();
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      {url ? (
        <a
          // A real link where there is a tab to open, so the browser's own affordances
          // (middle-click, "open in new tab", long-press) work on it too.
          href={tabUrl ?? url}
          target="_blank"
          rel="noopener"
          onClick={(event) => {
            // The APK's WebView opens no popup window, so hand the image to the phone's
            // viewer instead.
            if (!native) return;
            event.preventDefault();
            openFull();
          }}
          className="block bg-surface-2"
          aria-label={`Open ${filename}`}
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
      <div className="flex items-center gap-1 px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{filename}</span>
          <span className="block text-xs text-faint">{humanSize(attachment.sizeBytes)}</span>
        </span>
        <button
          type="button"
          onClick={openFull}
          disabled={!online}
          aria-label="Open"
          title={native ? 'Open in viewer' : 'Open in new tab'}
          className={ACTION}
        >
          <NewWindowIcon className="size-5" />
        </button>
        {canShare && (
          <button
            type="button"
            onClick={() => void actions.share()}
            disabled={!online}
            aria-label="Share"
            title="Share"
            className={ACTION}
          >
            <ShareIcon className="size-5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => void actions.download()}
          disabled={!online}
          aria-label="Download"
          title="Download"
          className={ACTION}
        >
          <DownloadIcon className="size-5" />
        </button>
      </div>
    </div>
  );
}
