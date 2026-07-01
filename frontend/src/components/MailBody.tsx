import { useEffect, useRef, useState } from 'react';
import { useTheme, type ResolvedTheme } from '../state/theme';

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

/**
 * The Content-Security-Policy meta value used inside the message iframe. `default-src
 * 'none'` blocks scripts/fetch/frames outright (defence in depth on top of the
 * sandbox); inline styles are allowed so sender CSS still renders. Remote images/media
 * are gated by `allowImages` — `data:` is ALWAYS permitted (inline CID art), so when
 * images are blocked only network loads (tracking pixels) are stopped.
 */
export function messageCsp(allowImages: boolean): string {
  const remote = allowImages ? 'data: https: http:' : 'data:';
  return `default-src 'none'; img-src ${remote}; media-src ${remote}; style-src 'unsafe-inline'; font-src data: https: http:;`;
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

  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${messageCsp(allowImages)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
  :root { color-scheme: ${scheme}; }
  html,body { margin:0; padding:12px; background:${pageBg}; color:${pageFg};
    font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    /* break-word breaks a long URL only when it would actually overflow, and —
       unlike overflow-wrap:anywhere / word-break:break-word — does NOT lower an
       element's min-content width to one glyph. The aggressive variants collapse
       table columns to a single character (GitHub CI emails rendered "docker"
       one letter per line), so keep wrapping conservative here. */
    overflow-wrap:break-word; }
  img { max-width:100%; height:auto; }
  a { color:${linkFg}; }
  /* Contain tables that declare no width of their own, but DON'T override an
     email's explicit (usually narrower) max-width — forcing 100% with !important
     stretches centered-card layouts like GitHub's notifications full-width. An
     inline max-width on the table out-specifies this element rule and wins. */
  table { max-width:100%; }
</style></head><body>${stripScripts(html)}</body></html>`;
}

/**
 * Render email HTML safely. Untrusted sender HTML is dropped into a sandboxed
 * iframe (no allow-scripts) so embedded scripts/inline handlers can't run and the
 * email's CSS can't leak into the app. A `<meta>` CSP hardens it further and, when
 * `allowImages` is false, blocks remote image/media loads (tracking pixels) while
 * still permitting inline `data:` images (e.g. embedded CID art). Height is measured
 * from the same-origin srcdoc document and the iframe grows to fit (no inner scrollbars).
 */
export function MailHtml({ html, allowImages = true }: { html: string; allowImages?: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);
  const theme = useTheme();

  const srcDoc = buildMailSrcDoc(html, allowImages, theme);

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    // Fixed-width desktop emails (e.g. a table with min-width:600px) are wider than
    // a phone viewport and can't be reflowed narrower. Rather than let them spill out
    // of the frame, lay the email out at its natural width and scale the whole body
    // down to fit — the "zoom to fit" Gmail/Apple Mail do. Content that already fits
    // is left untouched (scale 1), so centered-card layouts aren't shrunk needlessly.
    const measure = () => {
      const doc = iframe.contentDocument;
      const body = doc?.body;
      if (!body) return;
      const el = doc.documentElement;
      // Reset any prior fit so we can read the email's natural dimensions.
      body.style.transform = '';
      body.style.width = '';
      const avail = iframe.clientWidth;
      const naturalW = el.scrollWidth;
      let scale = 1;
      if (avail > 0 && naturalW > avail + 1) {
        scale = avail / naturalW;
        // Pin the body to its natural width so the scaled result lands exactly on
        // `avail`, and so the layout height is measured at the wide (un-reflowed) size.
        body.style.width = `${naturalW}px`;
      }
      const naturalH = el.scrollHeight;
      if (scale !== 1) {
        body.style.transformOrigin = 'top left';
        body.style.transform = `scale(${scale})`;
      }
      setHeight(Math.ceil(naturalH * scale));
    };
    iframe.addEventListener('load', measure);
    window.addEventListener('resize', measure);
    // Re-measure shortly after load for late image reflow.
    const t = setTimeout(measure, 600);
    return () => {
      iframe.removeEventListener('load', measure);
      window.removeEventListener('resize', measure);
      clearTimeout(t);
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

export function MailText({ text }: { text: string }) {
  return (
    <pre className="mail-html whitespace-pre-wrap font-sans text-[15px] leading-relaxed text-fg">
      {text}
    </pre>
  );
}
