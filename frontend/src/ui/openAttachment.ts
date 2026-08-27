/**
 * Getting an attachment out of maily and into the platform — the one place that knows
 * how each shell can actually receive a file.
 *
 * Two intents, because "tapped the file" and "pressed Download" are not the same wish:
 * `openAttachment` shows it wherever this platform shows files best, `saveAttachment`
 * always puts it on disk. They share the Android path, where the shell decides.
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
 * A desktop browser gets the *server* URL in a new tab instead of a blob: it carries no
 * inherited policy, it streams (an attachment can be tens of MB, which a blob holds in
 * memory), the tab survives a reload, and the viewer is titled with the sender's
 * filename. Everything else — phones, the installed PWA on a phone, a blocked popup —
 * gets an `<a download>` click, which is same-document, subject to neither trap above,
 * and the only path that carries the filename onto disk.
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

/**
 * Types a browser renders in a tab of its own *and* cannot script the page it came
 * from. Attachments are untrusted sender content served from maily's own origin, so
 * `text/html`, `image/svg+xml` and the XML family are deliberately absent — opening one
 * of those would run a stranger's markup as maily. Anything unlisted downloads, which
 * is what a browser would do with it anyway.
 */
const VIEWABLE_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
]);

function isViewableType(mimeType: string | null | undefined): boolean {
  const type = (mimeType ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  return VIEWABLE_TYPES.has(type) || type.startsWith('audio/') || type.startsWith('video/');
}

/**
 * Whether to show this attachment in a browser tab rather than download it. Three
 * conditions, all of them necessary:
 *
 * - a **type** the browser renders safely (above);
 * - a **desktop pointer**, because a tab is only a better answer where there are tabs
 *   and a window manager — on a phone (browser or installed PWA) a download hands the
 *   file to the OS, which is the handling that works there;
 * - **no in-app token**: a top-level navigation carries no `Authorization` header, so
 *   the URL has to authenticate itself. It does when a gateway fronts maily
 *   (`MAILY_DISABLE_AUTH`), which is what a browser session is already authenticated
 *   against; with maily's own login in use the tab would land on a 401, so it downloads
 *   through `fetch` instead.
 */
function opensInATab(attachment: AttachmentDto): boolean {
  if (getToken()) return false;
  if (!isViewableType(attachment.mimeType)) return false;
  return typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches === true;
}

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
 * Ask the Android shell to take the file, resolving false when this shell cannot —
 * which means an APK older than the method, since the web app is served from the server
 * and can be newer than the installed shell.
 *
 * The shell fetches the bytes itself rather than taking them across the bridge: an
 * attachment can be tens of MB, and base64 through a bridge call that size is a stall at
 * best. It authenticates with the WebView's own cookies (this deployment is
 * SSO-fronted) plus the app token when maily's own login is in use.
 */
async function handToAndroid(
  messageId: string,
  attachment: AttachmentDto,
  filename: string,
): Promise<boolean> {
  if (!isNativeAndroid()) return false;
  return openNativeFile({
    url: new URL(attachmentUrl(messageId, attachment.id), window.location.href).toString(),
    filename,
    mimeType: attachment.mimeType,
    authorization: getToken(),
  });
}

/**
 * Show one attachment: opened by a real app on Android, rendered in a new tab on a
 * desktop browser, downloaded anywhere else. `cached` is the bytes if the caller already
 * fetched them (the image preview has), so a download costs no second fetch.
 *
 * Rejects on failure — callers surface that as a retry, since a silent no-op is exactly
 * the bug this replaces.
 */
export async function openAttachment(
  messageId: string,
  attachment: AttachmentDto,
  cached?: Blob | null,
): Promise<void> {
  // The tab is opened before anything is awaited, so it is still the user's click that
  // opens it — a popup blocker rejects a `window.open` issued after an `await`, which
  // is half of what was wrong with the call this replaced. Both checks are property
  // reads; a blocked popup returns null and falls through to the download below, which
  // beats leaving the click looking ignored.
  if (!isNativeAndroid() && opensInATab(attachment)) {
    if (window.open(attachmentUrl(messageId, attachment.id), '_blank')) return;
  }
  await saveAttachment(messageId, attachment, cached);
}

/**
 * Put one attachment on disk (the explicit Download action, and the fallback for
 * everything `openAttachment` cannot show). Android still goes through the shell — a
 * WebView can save no `blob:`, so the shell's "open or save" handoff is the only thing
 * there that reaches the filesystem at all.
 */
export async function saveAttachment(
  messageId: string,
  attachment: AttachmentDto,
  cached?: Blob | null,
): Promise<void> {
  const filename = attachment.filename || FALLBACK_FILENAME;
  if (await handToAndroid(messageId, attachment, filename)) return;
  saveBlob(cached ?? (await fetchAttachmentBlob(messageId, attachment.id)), filename);
}
