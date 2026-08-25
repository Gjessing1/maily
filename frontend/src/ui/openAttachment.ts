/**
 * Getting an attachment out of maily and into the platform — the one place that knows
 * how each shell can actually receive a file.
 *
 * This used to be `window.open(objectUrl)`, which works in neither shell that matters:
 *
 * - **Android APK.** Capacitor leaves `setSupportMultipleWindows` off, so the WebView
 *   opens no popup at all and the tap silently does nothing — the same trap that broke
 *   links inside a message (see `mailLink.ts`). Nor is there a fallback: a WebView's
 *   download hook never fires for a `blob:` URL, so only the shell can fetch the bytes
 *   and hand them to an app that can open them.
 * - **Browsers.** A `blob:` document inherits the CSP of the page that created it, and
 *   the app shell serves `object-src 'none'` (backend `http/static.ts`). Chrome renders
 *   a PDF through a plugin document, so the inherited policy blocks it and the new tab
 *   comes up blank — which is why PDFs stopped opening. A popup blocker rejects the
 *   `window.open` anyway, because it is issued after an `await`.
 *
 * A download instead: an `<a download>` click is same-document, so it is subject to
 * neither, and it is the only path that carries the sender's filename.
 */
import type { AttachmentDto } from '@maily/shared';
import { attachmentUrl, fetchAttachmentBlob, getToken } from '../api/client';
import { isNativeAndroid, openNativeFile } from '../nativeAndroid';

/** Used when a sender attached a file without naming it. */
const FALLBACK_FILENAME = 'attachment';

/**
 * How long an object URL is kept alive after the anchor click. Revoking it in the same
 * turn cancels the download in Firefox and Safari, which read the blob asynchronously;
 * the timer bounds the leak instead of leaving it to the page's lifetime.
 */
const OBJECT_URL_TTL_MS = 60_000;

/** Save a blob the caller already holds to the user's downloads, under `filename`. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename || FALLBACK_FILENAME;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_TTL_MS);
}

/**
 * Hand one attachment to the platform: opened by a real app on Android, downloaded
 * everywhere else. `cached` is the bytes if the caller already fetched them (the image
 * preview has), so the common case costs no second download.
 *
 * Rejects on failure — callers surface that as a retry, since a silent no-op is exactly
 * the bug this replaces.
 */
export async function openAttachment(
  messageId: string,
  attachment: AttachmentDto,
  cached?: Blob | null,
): Promise<void> {
  const filename = attachment.filename || FALLBACK_FILENAME;

  if (isNativeAndroid()) {
    // The shell fetches the bytes itself rather than taking them across the bridge: an
    // attachment can be tens of MB, and base64 through a bridge call that size is a
    // stall at best. It authenticates with the WebView's own cookies (this deployment
    // is SSO-fronted) plus the app token when maily's own login is in use.
    const handed = await openNativeFile({
      url: new URL(attachmentUrl(messageId, attachment.id), window.location.href).toString(),
      filename,
      mimeType: attachment.mimeType,
      authorization: getToken(),
    });
    // `false` only for an APK older than the method — the web app can be newer than the
    // installed shell. The download below can't work in a WebView either, but it is
    // harmless, and failing loudly beats pretending the tap did something.
    if (handed) return;
  }

  saveBlob(cached ?? (await fetchAttachmentBlob(messageId, attachment.id)), filename);
}
