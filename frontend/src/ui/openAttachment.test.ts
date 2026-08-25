/**
 * Tapping an attachment used to call `window.open` on an object URL, which opens
 * nothing in either shell maily ships in: the APK's WebView creates no popup window at
 * all, and in a browser the `blob:` document inherits the app shell's `object-src 'none'`
 * so Chrome's PDF viewer is blocked and the tab comes up blank.
 *
 * What is pinned here is that neither shell can regress to a silent no-op: the APK gets
 * a native call, everything else gets a real download carrying the sender's filename.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchAttachmentBlob = vi.fn(async () => new Blob(['%PDF-1.6'], { type: 'application/pdf' }));

vi.mock('../api/client', () => ({
  attachmentUrl: (messageId: string, attId: string) =>
    `/api/messages/${messageId}/attachments/${attId}`,
  fetchAttachmentBlob,
  getToken: () => 'jwt-token',
}));

const openFile = vi.fn<(request: unknown) => Promise<void>>();
let native = true;
let hasOpenFile = true;

vi.mock('../nativeAndroid', () => ({
  isNativeAndroid: () => native,
  openNativeFile: async (request: unknown) => {
    if (!native || !hasOpenFile) return false;
    await openFile(request);
    return true;
  },
}));

const PDF = {
  id: 'att-1',
  filename: '247201_002657536.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 11281,
  isInline: false,
} as never;

/** What the download anchor carried, read at click time (it removes itself after). */
interface DownloadClick {
  download: string;
  href: string;
}

function captureDownloadClick(): () => DownloadClick | null {
  let clicked: DownloadClick | null = null;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked = { download: this.download, href: this.href };
  });
  return () => clicked;
}

describe('handing an attachment to the platform', () => {
  beforeEach(() => {
    native = false;
    hasOpenFile = true;
    vi.clearAllMocks();
    vi.restoreAllMocks();
    URL.createObjectURL = vi.fn(() => 'blob:maily/1');
    URL.revokeObjectURL = vi.fn();
  });

  it('downloads under the sender filename in a browser, never through a popup', async () => {
    const clicked = captureDownloadClick();
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    const { openAttachment } = await import('./openAttachment');

    await openAttachment('msg-1', PDF);

    expect(fetchAttachmentBlob).toHaveBeenCalledWith('msg-1', 'att-1');
    expect(opened).not.toHaveBeenCalled();
    expect(clicked()?.download).toBe('247201_002657536.pdf');
    expect(clicked()?.href).toContain('blob:maily/1');
    // Anchors clean up after themselves; a leftover would accumulate per tap.
    expect(document.querySelector('a')).toBeNull();
  });

  it('reuses bytes the caller already fetched instead of downloading twice', async () => {
    captureDownloadClick();
    const { openAttachment } = await import('./openAttachment');

    await openAttachment('msg-1', PDF, new Blob(['cached'], { type: 'application/pdf' }));

    expect(fetchAttachmentBlob).not.toHaveBeenCalled();
  });

  it('hands the APK an absolute URL and the credentials, fetching nothing itself', async () => {
    native = true;
    const { openAttachment } = await import('./openAttachment');

    await openAttachment('msg-1', PDF);

    expect(fetchAttachmentBlob).not.toHaveBeenCalled();
    expect(openFile).toHaveBeenCalledWith({
      url: `${window.location.origin}/api/messages/msg-1/attachments/att-1`,
      filename: '247201_002657536.pdf',
      mimeType: 'application/pdf',
      authorization: 'jwt-token',
    });
  });

  it('falls back to a download on an APK older than the native method', async () => {
    native = true;
    hasOpenFile = false;
    const clicked = captureDownloadClick();
    const { openAttachment } = await import('./openAttachment');

    await openAttachment('msg-1', PDF);

    expect(openFile).not.toHaveBeenCalled();
    expect(clicked()?.download).toBe('247201_002657536.pdf');
  });

  it('names an unnamed attachment rather than saving it as "download"', async () => {
    const clicked = captureDownloadClick();
    const { openAttachment } = await import('./openAttachment');

    await openAttachment('msg-1', { ...(PDF as object), filename: null } as never);

    expect(clicked()?.download).toBe('attachment');
  });

  it('rejects when the bytes cannot be had, so the tap is never silently ignored', async () => {
    fetchAttachmentBlob.mockRejectedValueOnce(new Error('attachment fetch failed') as never);
    const { openAttachment } = await import('./openAttachment');

    await expect(openAttachment('msg-1', PDF)).rejects.toThrow('attachment fetch failed');
  });
});
