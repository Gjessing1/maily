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
import {
  canShareNativeFile,
  isNativeAndroid,
  openNativeFile,
  saveNativeFile,
  shareNativeFile,
  type NativeFileRequest,
} from '../nativeAndroid';

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
function nativeRequest(messageId: string, attachment: AttachmentDto): NativeFileRequest {
  return {
    url: absoluteAttachmentUrl(messageId, attachment),
    filename: attachment.filename || FALLBACK_FILENAME,
    mimeType: attachment.mimeType,
    authorization: getToken(),
  };
}

async function handToAndroid(messageId: string, attachment: AttachmentDto): Promise<boolean> {
  if (!isNativeAndroid()) return false;
  return openNativeFile(nativeRequest(messageId, attachment));
}

/** The attachment's bytes as an absolute URL on this server. */
function absoluteAttachmentUrl(messageId: string, attachment: AttachmentDto): string {
  return new URL(attachmentUrl(messageId, attachment.id), window.location.href).toString();
}

/**
 * Where to navigate a browser tab to show an image full-size, given the object URL of
 * the preview's bytes if they were fetched. The server URL when no in-app token is in
 * use — the tab then streams the original, survives a reload and is titled with the
 * filename (the gateway's cookie authenticates it) — else the object URL, since a
 * top-level navigation cannot carry the `Authorization` header. Null when neither works
 * yet (in-app login, preview not loaded).
 */
export function imageTabUrl(
  messageId: string,
  attachment: AttachmentDto,
  objectUrl: string | null,
): string | null {
  return getToken() ? objectUrl : absoluteAttachmentUrl(messageId, attachment);
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
  // Android: the shell downloads it and hands it to the app that views the type.
  if (await handToAndroid(messageId, attachment)) return;
  if (opensInATab(attachment)) {
    if (window.open(attachmentUrl(messageId, attachment.id), '_blank')) return;
  }
  await saveAttachment(messageId, attachment, cached);
}

/**
 * Put one attachment on disk (the explicit Download action, and the fallback for
 * everything `openAttachment` cannot show). Android goes through the shell — a WebView
 * can save no `blob:` — which saves it into the phone's Downloads (APK 0.5.0+); an older
 * shell only has its "open or save" viewer handoff.
 */
export async function saveAttachment(
  messageId: string,
  attachment: AttachmentDto,
  cached?: Blob | null,
): Promise<SaveOutcome> {
  const filename = attachment.filename || FALLBACK_FILENAME;
  if (isNativeAndroid()) {
    const saved = await saveNativeFile(nativeRequest(messageId, attachment));
    if (saved !== false) {
      return saved === null ? { kind: 'handed-off' } : { kind: 'saved', name: saved };
    }
    // An APK older than saveFile: its "open or save" handoff is all it has — and one
    // older still has neither, so it falls through to the browser download below.
    if (await handToAndroid(messageId, attachment)) return { kind: 'handed-off' };
  }
  saveBlob(cached ?? (await fetchAttachmentBlob(messageId, attachment.id)), filename);
  return { kind: 'downloaded' };
}

/**
 * What a save did, so the caller can say so. A browser download shows its own UI, so
 * only the Android save — which is otherwise silent — names where the file went.
 */
export type SaveOutcome =
  | { kind: 'saved'; name: string }
  | { kind: 'downloaded' }
  | { kind: 'handed-off' };

/** A throwaway file to ask the Web Share API whether it takes files of this type. */
function probeFile(attachment: AttachmentDto): File {
  return new File([''], attachment.filename || FALLBACK_FILENAME, {
    type: attachment.mimeType || 'application/octet-stream',
  });
}

/**
 * Whether this platform can put the attachment on a share sheet: the Android shell's own
 * (APK 0.5.0+), or the Web Share API where it accepts files — phone browsers and
 * installed PWAs, some desktop ones. Where neither exists the Share action is hidden
 * rather than quietly downgraded to a download.
 */
export function canShareAttachment(attachment: AttachmentDto): boolean {
  if (isNativeAndroid()) return canShareNativeFile();
  if (typeof navigator === 'undefined' || typeof navigator.canShare !== 'function') return false;
  try {
    return navigator.canShare({ files: [probeFile(attachment)] });
  } catch {
    return false;
  }
}

/**
 * Share one attachment. On Android the shell fetches it and opens the share sheet; in a
 * browser the bytes (reused from `cached` when the preview already has them) go through
 * the Web Share API. Resolves quietly when the user dismisses the sheet.
 */
export async function shareAttachment(
  messageId: string,
  attachment: AttachmentDto,
  cached?: Blob | null,
): Promise<void> {
  if (isNativeAndroid()) {
    if (await shareNativeFile(nativeRequest(messageId, attachment))) return;
    // Older APK: its viewer handoff falls back to the share sheet for unviewable types.
    if (await handToAndroid(messageId, attachment)) return;
  }
  const blob = cached ?? (await fetchAttachmentBlob(messageId, attachment.id));
  const filename = attachment.filename || FALLBACK_FILENAME;
  const file = new File([blob], filename, { type: attachment.mimeType || blob.type });
  try {
    await navigator.share({ files: [file], title: filename });
  } catch (error) {
    // The user closing the sheet is not a failure.
    if (error instanceof DOMException && error.name === 'AbortError') return;
    throw error;
  }
}
