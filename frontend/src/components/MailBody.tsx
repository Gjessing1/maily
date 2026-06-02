import { useEffect, useRef, useState } from 'react';

/** True if the HTML references a remote (http/https) image or CSS background url(). */
export function hasRemoteImages(html: string): boolean {
  return (
    /<img\b[^>]*\bsrc\s*=\s*["']?\s*https?:/i.test(html) || /\burl\(\s*["']?\s*https?:/i.test(html)
  );
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

  // default-src 'none' blocks scripts/fetch/frames outright (defence in depth on top
  // of the sandbox); inline styles are allowed so sender CSS still renders. Remote
  // images are gated by allowImages — data: is always permitted for inline art.
  const imgSrc = allowImages ? 'data: https: http:' : 'data:';
  const mediaSrc = allowImages ? 'data: https: http:' : 'data:';
  const csp = `default-src 'none'; img-src ${imgSrc}; media-src ${mediaSrc}; style-src 'unsafe-inline'; font-src data: https: http:;`;

  const srcDoc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
  :root { color-scheme: dark; }
  html,body { margin:0; padding:12px; background:#15151c; color:#f4f4f6;
    font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    overflow-wrap:anywhere; word-break:break-word; }
  img { max-width:100%; height:auto; }
  a { color:#8b8aff; }
  table { max-width:100% !important; }
</style></head><body>${html}</body></html>`;

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    const measure = () => {
      const doc = iframe.contentDocument;
      if (doc?.body) setHeight(doc.documentElement.scrollHeight);
    };
    iframe.addEventListener('load', measure);
    // Re-measure shortly after load for late image reflow.
    const t = setTimeout(measure, 600);
    return () => {
      iframe.removeEventListener('load', measure);
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
