import { useEffect, useRef, useState } from 'react';

/**
 * Render email HTML safely. Untrusted sender HTML is dropped into a sandboxed
 * iframe (no allow-scripts) so embedded scripts/inline handlers can't run and the
 * email's CSS can't leak into the app. Height is measured from the same-origin
 * srcdoc document and the iframe grows to fit (no inner scrollbars).
 */
export function MailHtml({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);

  const srcDoc = `<!doctype html><html><head><meta charset="utf-8">
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
