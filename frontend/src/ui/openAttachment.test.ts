/**
 * Tapping an attachment used to call `window.open` on an object URL, which opens
 * nothing in either shell maily ships in: the APK's WebView creates no popup window at
 * all, and in a browser the `blob:` document inherits the app shell's `object-src 'none'`
 * so Chrome's PDF viewer is blocked and the tab comes up blank.
 *
 * What is pinned here is that no shell can regress to a silent no-op: the APK gets a
 * native call, a desktop browser gets the server URL in a tab, and everything else gets
 * a real download carrying the sender's filename. Plus the two limits on that tab — it
 * is maily's own origin, so a stranger's markup must never be rendered in it, and a
 * top-level navigation carries no `Authorization` header.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchAttachmentBlob = vi.fn(async () => new Blob(['%PDF-1.6'], { type: 'application/pdf' }));

/** maily's own login in use (the SSO-fronted deployment has none — see `signedInWith`). */
let token: string | null = 'jwt-token';

vi.mock('../api/client', () => ({
  attachmentUrl: (messageId: string, attId: string) =>
    `/api/messages/${messageId}/attachments/${attId}`,
  fetchAttachmentBlob,
  getToken: () => token,
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

/** Point the platform checks at a desktop browser fronted by a gateway, or a phone. */
function browsingFrom(kind: 'desktop' | 'phone'): void {
  token = kind === 'desktop' ? null : 'jwt-token';
  window.matchMedia = ((query: string) =>
    ({
      matches: kind === 'desktop' && query.includes('pointer: fine'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

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
  const realMatchMedia = window.matchMedia;

  beforeEach(() => {
    native = false;
    hasOpenFile = true;
    token = 'jwt-token';
    window.matchMedia = realMatchMedia;
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

  it('shows a viewable attachment in a tab on a desktop browser', async () => {
    browsingFrom('desktop');
    const clicked = captureDownloadClick();
    const opened = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    const { openAttachment } = await import('./openAttachment');

    await openAttachment('msg-1', PDF);

    // The server URL, not a blob: it streams, it survives a reload, and it inherits no
    // CSP. And nothing is fetched here — the browser does that itself.
    expect(opened).toHaveBeenCalledWith('/api/messages/msg-1/attachments/att-1', '_blank');
    expect(fetchAttachmentBlob).not.toHaveBeenCalled();
    expect(clicked()).toBeNull();
  });

  it('downloads instead when the browser blocks the tab', async () => {
    browsingFrom('desktop');
    const clicked = captureDownloadClick();
    vi.spyOn(window, 'open').mockReturnValue(null);
    const { openAttachment } = await import('./openAttachment');

    await openAttachment('msg-1', PDF);

    expect(clicked()?.download).toBe('247201_002657536.pdf');
  });

  it("never renders a stranger's markup as maily", async () => {
    browsingFrom('desktop');
    const clicked = captureDownloadClick();
    const opened = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    const { openAttachment } = await import('./openAttachment');

    for (const mimeType of ['image/svg+xml', 'text/html', 'application/xhtml+xml']) {
      await openAttachment('msg-1', { ...(PDF as object), mimeType } as never);
      expect(opened).not.toHaveBeenCalled();
    }
    expect(clicked()?.download).toBe('247201_002657536.pdf');
  });

  it('leaves phones on the download path', async () => {
    browsingFrom('phone');
    const clicked = captureDownloadClick();
    const opened = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    const { openAttachment } = await import('./openAttachment');

    await openAttachment('msg-1', PDF);

    expect(opened).not.toHaveBeenCalled();
    expect(clicked()?.download).toBe('247201_002657536.pdf');
  });

  it("downloads on the desktop too when maily's own login is in use", async () => {
    browsingFrom('desktop');
    token = 'jwt-token';
    const clicked = captureDownloadClick();
    const opened = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    const { openAttachment } = await import('./openAttachment');

    await openAttachment('msg-1', PDF);

    // A top-level navigation carries no Authorization header, so the tab would 401.
    expect(opened).not.toHaveBeenCalled();
    expect(clicked()?.download).toBe('247201_002657536.pdf');
  });

  it('keeps the Download action a download, even where a tab would open', async () => {
    browsingFrom('desktop');
    const clicked = captureDownloadClick();
    const opened = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    const { saveAttachment } = await import('./openAttachment');

    await saveAttachment('msg-1', PDF);

    expect(opened).not.toHaveBeenCalled();
    expect(clicked()?.download).toBe('247201_002657536.pdf');
  });

  it('still hands the APK its native call from the Download action', async () => {
    native = true;
    const { saveAttachment } = await import('./openAttachment');

    await saveAttachment('msg-1', PDF);

    expect(openFile).toHaveBeenCalledTimes(1);
    expect(fetchAttachmentBlob).not.toHaveBeenCalled();
  });
});
