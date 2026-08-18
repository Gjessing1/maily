import { useEffect, useMemo, useRef, useState } from 'react';
import { openNativeExternal } from '../nativeAndroid';
import { showNotice } from '../state/undo';
import { useTheme, type ResolvedTheme } from '../state/theme';
import { splitQuotedHtml, splitQuotedText } from '../ui/quote';
import { createMailLinkClickHandler, type MailtoLink } from '../ui/mailLink';

/** True if the HTML references a remote (http/https) image or CSS background url(). */
export function hasRemoteImages(html: string): boolean {
  return (
    /<img\b[^>]*\bsrc\s*=\s*["']?\s*https?:/i.test(html) || /\burl\(\s*["']?\s*https?:/i.test(html)
  );
}

/**
 * Remove `<script>` blocks from sender HTML. The sandbox + CSP already prevent
 * execution, but the browser still logs a "Blocked script execution in
 * 'about:srcdoc'" warning for every script it refuses to run. Stripping them up
 * front keeps that out of the console and is harmless defence in depth.
 */
export function stripScripts(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '');
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Turn either a full HTML email or a fragment into pieces for our own sandbox
 * document. Nesting a sender's `<html><body>` inside our `<body>` makes browsers
 * ignore its body class/style, which breaks template CSS (notably GitHub mail).
 */
export function mailDocumentParts(html: string): { head: string; bodyAttrs: string; body: string } {
  const clean = stripScripts(html);
  if (typeof DOMParser === 'undefined') return { head: '', bodyAttrs: '', body: clean };
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  const styles = Array.from(doc.querySelectorAll('style'));
  const head = styles.map((style) => style.outerHTML).join('');
  for (const style of styles) style.remove();

  // Preserve only inert presentation attributes. Event handlers, navigation and
  // arbitrary metadata never cross onto the sandbox document's body element.
  const attrs = ['id', 'class', 'style', 'dir', 'lang', 'bgcolor']
    .map((name) => {
      const value = doc.body.getAttribute(name);
      return value == null ? '' : ` ${name}="${escapeAttribute(value)}"`;
    })
    .join('');
  return { head, bodyAttrs: attrs, body: doc.body.innerHTML };
}

/**
 * The Content-Security-Policy meta value used inside the message iframe. `default-src
 * 'none'` blocks scripts/fetch/frames outright (defence in depth on top of the
 * sandbox); inline styles are allowed so sender CSS still renders. Remote images/media
 * are gated by `allowImages` — `data:` is ALWAYS permitted (inline CID art), so when
 * images are blocked only network loads (tracking pixels) are stopped.
 */
export function messageCsp(allowImages: boolean): string {
  const remote = allowImages ? 'data: https: http:' : 'data:';
  // Sender-controlled remote fonts are never needed to understand a message and
  // are just as trackable as remote images. Keep only embedded data: fonts.
  return `default-src 'none'; img-src ${remote}; media-src ${remote}; style-src 'unsafe-inline'; font-src data:;`;
}

/**
 * True if sender HTML declares its own background colour — a `bgcolor` attribute or a
 * colour-bearing `background`/`background-color` CSS value. `transparent`/`none` and
 * `url()`-only backgrounds don't count (they don't establish a readable surface).
 */
export function declaresOwnBackground(html: string): boolean {
  if (/\bbgcolor\s*=\s*["']?\s*#?[0-9a-z]/i.test(html)) return true;
  if (
    /background-color\s*:(?!\s*(?:transparent|inherit|initial|none|unset)\b)\s*[^;\s"']/i.test(html)
  )
    return true;
  // `background` shorthand carrying an actual colour token (hex / rgb() / hsl()).
  if (/background\s*:\s*[^;"']*(#[0-9a-f]{3,8}|rgb|hsl)/i.test(html)) return true;
  return false;
}

/**
 * True if sender HTML sets its own text colour anywhere — a CSS `color:` (not
 * `background-color:`) or a `<font color>` attribute. Such colours are almost always
 * authored against a light background, so on a dark page they go unreadable.
 */
export function declaresOwnTextColor(html: string): boolean {
  if (/<font[^>]*\bcolor\s*=/i.test(html)) return true;
  return /(^|[^-\w])color\s*:/i.test(html);
}

/**
 * Pick the iframe's base colours. Light theme always renders light. In dark theme we
 * only darken the body for plaintext/unstyled emails (which inherit our colours
 * cleanly); any email that brings its own palette (a background or its own text
 * colours) is rendered on a light sheet instead, because forcing a dark background
 * behind sender colours authored for white leaves grey-on-dark text unreadable.
 */
export function pickMailColors(html: string, theme: ResolvedTheme) {
  const renderLight =
    theme === 'light' || declaresOwnBackground(html) || declaresOwnTextColor(html);
  return renderLight
    ? { scheme: 'light' as const, pageBg: '#ffffff', pageFg: '#18181f', linkFg: '#4a48d0' }
    : { scheme: 'dark' as const, pageBg: '#15151c', pageFg: '#f4f4f6', linkFg: '#8b8aff' };
}

/**
 * Build the sandboxed-iframe `srcdoc` for a piece of sender HTML: a hardening CSP
 * meta, theme-matched base colours (the sandbox blocks app CSS from leaking in), and
 * the script-stripped body. Pure so the sanitisation contract is unit-testable
 * without rendering the iframe.
 */
export function buildMailSrcDoc(html: string, allowImages: boolean, theme: ResolvedTheme): string {
  // The iframe is sandboxed (no app CSS leaks in), so its base colours are inlined
  // here per theme rather than via tokens. See pickMailColors: styled emails render
  // light even in dark mode so sender colours (authored for white) stay readable.
  const { scheme, pageBg, pageFg, linkFg } = pickMailColors(html, theme);
  const mail = mailDocumentParts(html);

  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${messageCsp(allowImages)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
  :root { color-scheme: ${scheme}; }
  html { margin:0; padding:0; background:${pageBg}; color:${pageFg}; }
  body { box-sizing:border-box; margin:0; padding:12px; background:${pageBg}; color:${pageFg};
    font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    /* break-word breaks a long URL only when it would actually overflow, and —
       unlike overflow-wrap:anywhere / word-break:break-word — does NOT lower an
       element's min-content width to one glyph. The aggressive variants collapse
       table columns to a single character (GitHub CI emails rendered "docker"
       one letter per line), so keep wrapping conservative here. */
    overflow-wrap:break-word; }
  img { max-width:100%; height:auto; }
  a { color:${linkFg}; }
  /* A long code/log block is local content overflow, not evidence that the whole
     email is a fixed-width desktop template. Without this, its min-content width
     makes the fit-to-width measurement shrink the ENTIRE message to tiny text
     (GitHub notifications commonly put syntax-highlighted Markdown in a <pre>).
     Wrap only preformatted blocks; fixed-width table newsletters still use the
     zoom-to-fit path below. */
  pre { max-width:100%; white-space:pre-wrap; overflow-wrap:anywhere; }
  code, samp, kbd { overflow-wrap:anywhere; }
  video, audio, iframe, object, embed { max-width:100%; }
  /* Contain tables that declare no width of their own, but DON'T override an
     email's explicit (usually narrower) max-width — forcing 100% with !important
     stretches centered-card layouts like GitHub's notifications full-width. An
     inline max-width on the table out-specifies this element rule and wins. */
  table { max-width:100%; }
</style>${mail.head}</head><body${mail.bodyAttrs}>${mail.body}</body></html>`;
}

/**
 * Contain a single pathological descendant before deciding that an entire email is
 * a fixed-width desktop template. This mutates only inline layout styles inside the
 * disposable sandbox document.
 */
export function containIsolatedOverflow(doc: Document, availableWidth: number): void {
  if (availableWidth <= 0) return;
  const elements = Array.from(doc.body.querySelectorAll<HTMLElement>('*'));
  for (const element of elements) {
    if (element.scrollWidth <= availableWidth + 1) continue;
    const tag = element.tagName.toLowerCase();
    if (/^(?:img|video|audio|iframe|object|embed)$/.test(tag)) {
      element.style.maxWidth = '100%';
      if (tag === 'img' || tag === 'video') element.style.height = 'auto';
      continue;
    }
    if (/^(?:pre|code|samp|kbd)$/.test(tag)) {
      element.style.maxWidth = '100%';
      element.style.whiteSpace = tag === 'pre' ? 'pre-wrap' : 'normal';
      element.style.overflowWrap = 'anywhere';
      continue;
    }
    if (/^(?:td|th)$/.test(tag) || /\S{48,}/u.test(element.textContent ?? '')) {
      element.style.maxWidth = `${availableWidth}px`;
      element.style.overflowWrap = 'anywhere';
      element.style.wordBreak = 'break-word';
    }
  }
}

/** True only for a wide top-level layout, not an arbitrary overflowing descendant. */
export function hasFixedWidthTemplate(doc: Document, availableWidth: number): boolean {
  const candidates = Array.from(doc.body.querySelectorAll<HTMLElement>('table,[width],[style]'));
  return candidates.some((element) => {
    let depth = 0;
    for (
      let parent = element.parentElement;
      parent && parent !== doc.body;
      parent = parent.parentElement
    )
      depth += 1;
    if (depth > 2 || element.scrollWidth <= availableWidth + 1) return false;
    const widthAttribute = Number.parseFloat(element.getAttribute('width') ?? '');
    const style = element.getAttribute('style') ?? '';
    const numericWidths = Array.from(
      style.matchAll(/(?:^|;)\s*(?:min-)?width\s*:\s*(\d+(?:\.\d+)?)px/gi),
      (match) => Number(match[1]),
    );
    return (
      element.tagName === 'TABLE' ||
      widthAttribute > availableWidth ||
      numericWidths.some((width) => width > availableWidth)
    );
  });
}

/**
 * The `•••` chip that stands in for collapsed quote history (the affordance
 * Outlook and Gmail both use). Sits in the app, not the iframe — the message
 * frame is sandboxed without `allow-scripts`, so nothing inside it can be clickable.
 */
function QuoteToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <div className="px-3 py-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={expanded ? 'Hide quoted text' : 'Show quoted text'}
        title={expanded ? 'Hide quoted text' : 'Show quoted text'}
        className="flex h-5 items-center rounded bg-surface px-2 leading-none text-muted ring-1 ring-border active:opacity-70"
      >
        <span className="-mt-1 text-base tracking-widest">···</span>
      </button>
    </div>
  );
}

interface MailFrameProps {
  html: string;
  allowImages?: boolean;
  /**
   * Open the app composer for a `mailto:` link in the message. Optional: without it
   * the address is handed to the platform's own mail handler instead.
   */
  onMailto?: (link: MailtoLink) => void;
}

/**
 * Render email HTML safely. Untrusted sender HTML is dropped into a sandboxed
 * iframe (no allow-scripts) so embedded scripts/inline handlers can't run and the
 * email's CSS can't leak into the app. A `<meta>` CSP hardens it further, gates remote
 * image/media loads while still permitting inline `data:` images (e.g. embedded CID
 * art), and always blocks remote fonts. Height is measured from the same-origin srcdoc
 * document and the iframe grows to fit (no inner scrollbars).
 */
function MailFrame({ html, allowImages = true, onMailto }: MailFrameProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);
  const theme = useTheme();

  const srcDoc = buildMailSrcDoc(html, allowImages, theme);

  // Held in a ref so a new handler identity never re-runs (and re-measures) the frame.
  const mailtoRef = useRef(onMailto);
  mailtoRef.current = onMailto;

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    // Fixed-width desktop emails (e.g. a table with min-width:600px) are wider than
    // a phone viewport and can't be reflowed narrower. Rather than let them spill out
    // of the frame, lay the email out at its natural width and scale the whole body
    // down to fit — the "zoom to fit" Gmail/Apple Mail do. Content that already fits
    // is left untouched (scale 1), so centered-card layouts aren't shrunk needlessly.
    let resizeObserver: ResizeObserver | null = null;
    let removeImageListeners: (() => void) | null = null;
    let removeLinkHandler: (() => void) | null = null;
    let animationFrame = 0;
    let lastObservedLayout = '';
    let disposed = false;

    const measure = () => {
      const doc = iframe.contentDocument;
      const body = doc?.body;
      if (!body) return;
      const el = doc.documentElement;
      // Reset any prior fit so we can read the email's natural dimensions.
      body.style.transform = '';
      body.style.width = '';
      body.style.maxWidth = '';
      body.style.overflowX = '';
      const avail = iframe.clientWidth;
      containIsolatedOverflow(doc, avail);
      const naturalW = el.scrollWidth;
      let scale = 1;
      if (avail > 0 && naturalW > avail + 1 && hasFixedWidthTemplate(doc, avail)) {
        scale = avail / naturalW;
        // Pin the body to its natural width so the scaled result lands exactly on
        // `avail`, and so the layout height is measured at the wide (un-reflowed) size.
        body.style.width = `${naturalW}px`;
      } else if (avail > 0 && naturalW > avail + 1) {
        // An isolated offender that resisted wrapping must not make all text tiny.
        // Clamp it to the reading sheet; explicit top-level desktop templates are
        // the only documents eligible for whole-message zoom above.
        body.style.maxWidth = `${avail}px`;
        body.style.overflowX = 'hidden';
      }
      // Collapse the frame before reading the height: `documentElement.scrollHeight`
      // can only report the frame's own box when the content is SHORTER than it, so
      // measuring at the current height would pin every short body to whatever the
      // frame already was (the initial 200px, leaving a dead gap under a one-line reply).
      iframe.style.height = '0px';
      const naturalH = el.scrollHeight;
      if (scale !== 1) {
        body.style.transformOrigin = 'top left';
        body.style.transform = `scale(${scale})`;
      }
      const next = Math.ceil(naturalH * scale);
      // Write the height back directly as well as through state: when `next` equals the
      // current state React skips the re-render, and the collapsed inline style above
      // would stick.
      iframe.style.height = `${next}px`;
      setHeight(next);
      lastObservedLayout = `${body.scrollWidth}:${body.scrollHeight}:${avail}`;
    };

    const scheduleMeasure = (force = false) => {
      const body = iframe.contentDocument?.body;
      if (!body || disposed) return;
      const signature = `${body.scrollWidth}:${body.scrollHeight}:${iframe.clientWidth}`;
      if (!force && signature === lastObservedLayout) return;
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        animationFrame = 0;
        measure();
      });
    };

    /**
     * Route the sender's links from OUT here. The frame is sandboxed without
     * `allow-top-navigation` and the Android WebView opens no popup window, so an
     * anchor left to itself does nothing at all (see ui/mailLink). The listener is
     * registered by the app document — the frame itself still runs no scripts.
     */
    const installLinkRouting = (doc: Document) => {
      removeLinkHandler?.();
      const onClick = createMailLinkClickHandler({
        openExternal: (url) => {
          void openNativeExternal(url).catch(() => showNotice('Could not open that link'));
        },
        openCompose: (link) => {
          const compose = mailtoRef.current;
          // No composer to hand it to (the rendering-fixture page): let the platform
          // resolve the address rather than swallowing the tap.
          if (compose) compose(link);
          else window.location.href = `mailto:${link.to.join(',')}`;
        },
        // Non-web schemes navigate the APP document, not the sandboxed frame: the host
        // (Capacitor on Android, the browser elsewhere) turns them into a dialer/SMS
        // hand-off there, which the frame is not allowed to trigger.
        openPlatform: (url) => {
          window.location.href = url;
        },
      });
      doc.addEventListener('click', onClick);
      removeLinkHandler = () => doc.removeEventListener('click', onClick);
    };

    const installLayoutObservers = () => {
      resizeObserver?.disconnect();
      removeImageListeners?.();
      const doc = iframe.contentDocument;
      const body = doc?.body;
      if (!doc || !body) return;
      measure();

      const Observer = window.ResizeObserver;
      if (Observer) {
        const observer = new Observer(() => scheduleMeasure());
        observer.observe(body);
        resizeObserver = observer;
      }

      const images = Array.from(doc.images);
      const onImageSettled = () => scheduleMeasure();
      for (const image of images) {
        image.addEventListener('load', onImageSettled);
        image.addEventListener('error', onImageSettled);
      }
      removeImageListeners = () => {
        for (const image of images) {
          image.removeEventListener('load', onImageSettled);
          image.removeEventListener('error', onImageSettled);
        }
      };

      // Embedded/data fonts can still alter metrics after load. Remote sender fonts
      // are blocked by CSP, so this promise never creates a network side channel.
      void doc.fonts?.ready.then(() => scheduleMeasure());

      installLinkRouting(doc);
    };

    iframe.addEventListener('load', installLayoutObservers);
    const onWindowResize = () => scheduleMeasure(true);
    window.addEventListener('resize', onWindowResize);
    if (iframe.contentDocument?.readyState === 'complete') installLayoutObservers();
    return () => {
      disposed = true;
      iframe.removeEventListener('load', installLayoutObservers);
      window.removeEventListener('resize', onWindowResize);
      resizeObserver?.disconnect();
      removeImageListeners?.();
      removeLinkHandler?.();
      if (animationFrame) cancelAnimationFrame(animationFrame);
    };
  }, [srcDoc]);

  return (
    <iframe
      ref={ref}
      title="message"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      className="w-full border-0"
      style={{ height }}
    />
  );
}

/**
 * A message body: the reply itself, then the quote history the sender piled under
 * it, hidden behind a `•••` chip. The two halves get their own iframes rather than
 * one frame with a toggle inside it, because the frame can't run scripts.
 */
export function MailHtml({ html, allowImages = true, onMailto }: MailFrameProps) {
  const { visible, quoted } = useMemo(() => splitQuotedHtml(html), [html]);
  const [expanded, setExpanded] = useState(false);

  if (!quoted) return <MailFrame html={html} allowImages={allowImages} onMailto={onMailto} />;
  return (
    <>
      <MailFrame html={visible} allowImages={allowImages} onMailto={onMailto} />
      <QuoteToggle expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
      {expanded && <MailFrame html={quoted} allowImages={allowImages} onMailto={onMailto} />}
    </>
  );
}

function TextBlock({ text }: { text: string }) {
  return (
    <pre className="mail-html whitespace-pre-wrap font-sans text-[15px] leading-relaxed text-fg">
      {text}
    </pre>
  );
}

export function MailText({ text }: { text: string }) {
  const { visible, quoted } = useMemo(() => splitQuotedText(text), [text]);
  const [expanded, setExpanded] = useState(false);

  if (!quoted) return <TextBlock text={text} />;
  return (
    <>
      <TextBlock text={visible} />
      {/* -mx-1 pulls the chip back to the text's left edge (QuoteToggle pads for
          the iframe's own 12px body padding, which plain text doesn't have). */}
      <div className="-mx-1">
        <QuoteToggle expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
      </div>
      {expanded && <TextBlock text={quoted} />}
    </>
  );
}
