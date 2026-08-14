/**
 * Sanitisation / CSP contract for rendered email HTML (Refactoring Phase 5d).
 * Sender HTML is untrusted, so the security-relevant behaviour is pinned here:
 *   - remote-image detection (drives the tracking-pixel "load images?" gate),
 *   - the iframe CSP (default-src 'none'; remote img/media only when allowed),
 *   - `<script>` stripping before the HTML ever reaches the srcdoc.
 * These are the pure pieces of MailBody — no iframe render needed.
 */
import { describe, expect, test } from 'vitest';
import {
  buildMailSrcDoc,
  containIsolatedOverflow,
  declaresOwnBackground,
  declaresOwnTextColor,
  hasRemoteImages,
  hasFixedWidthTemplate,
  messageCsp,
  mailDocumentParts,
  stripScripts,
} from './MailBody';

describe('hasRemoteImages', () => {
  test('flags a remote <img src> and a CSS url() background', () => {
    expect(hasRemoteImages('<img src="https://tracker.example/pixel.gif">')).toBe(true);
    expect(hasRemoteImages('<div style="background:url(http://x.example/bg.png)">')).toBe(true);
  });

  test('ignores inline data: images and plain text', () => {
    expect(hasRemoteImages('<img src="data:image/png;base64,AAAA">')).toBe(false);
    expect(hasRemoteImages('<p>no images here</p>')).toBe(false);
  });
});

describe('messageCsp', () => {
  test('allowImages permits remote img/media; blocked allows only data:', () => {
    const allowed = messageCsp(true);
    expect(allowed).toContain("default-src 'none'");
    expect(allowed).toContain('img-src data: https: http:');
    expect(allowed).toContain('media-src data: https: http:');

    const blocked = messageCsp(false);
    expect(blocked).toContain('img-src data:;');
    expect(blocked).toContain('media-src data:;');
    // Crucially, no remote scheme leaks into the blocked policy's img/media.
    expect(blocked).not.toMatch(/img-src[^;]*https:/);
    expect(blocked).not.toMatch(/media-src[^;]*https:/);
  });

  test('inline styles stay allowed so sender CSS renders', () => {
    expect(messageCsp(true)).toContain("style-src 'unsafe-inline'");
  });

  test('remote sender fonts stay blocked even after image consent', () => {
    expect(messageCsp(true)).toContain('font-src data:;');
    expect(messageCsp(true)).not.toMatch(/font-src[^;]*https?:/);
    expect(messageCsp(false)).not.toMatch(/font-src[^;]*https?:/);
  });
});

describe('stripScripts', () => {
  test('removes block and self-closing script tags but keeps surrounding markup', () => {
    const html = '<p>hi</p><script>alert(1)</script><b>bye</b><script src="x.js"/>';
    const out = stripScripts(html);
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('<p>hi</p>');
    expect(out).toContain('<b>bye</b>');
  });
});

describe('buildMailSrcDoc', () => {
  test('embeds the CSP meta, strips scripts, and themes the page colour-scheme', () => {
    const doc = buildMailSrcDoc('<p>body</p><script>evil()</script>', false, 'dark');
    expect(doc).toContain('Content-Security-Policy');
    expect(doc).toContain(messageCsp(false));
    expect(doc).toContain('<p>body</p>');
    expect(doc).not.toContain('evil()');
    expect(doc).toContain('color-scheme: dark');
  });

  test('light vs dark pick different base colours', () => {
    expect(buildMailSrcDoc('', true, 'light')).toContain('#ffffff');
    expect(buildMailSrcDoc('', true, 'dark')).toContain('#15151c');
  });

  test('in dark mode, an email with its own text colours renders on a light sheet', () => {
    // Sender greys authored for white would be unreadable on our dark background, so
    // the body is rendered light instead (light bg, light colour-scheme).
    const doc = buildMailSrcDoc('<p style="color:#888">grey note</p>', true, 'dark');
    expect(doc).toContain('#ffffff');
    expect(doc).toContain('color-scheme: light');
    expect(doc).not.toContain('#15151c');
  });

  test('in dark mode, a plaintext-ish email keeps the dark treatment', () => {
    const doc = buildMailSrcDoc('<p>just words, no styling</p>', true, 'dark');
    expect(doc).toContain('#15151c');
    expect(doc).toContain('color-scheme: dark');
  });

  test('preserves a full email document body class/style without nesting body tags', () => {
    const doc = buildMailSrcDoc(
      '<html><head><style>.github-mail{width:544px}</style></head>' +
        '<body class="github-mail" style="margin: 0"><p>Build passed</p></body></html>',
      true,
      'light',
    );
    expect(doc).toContain('<style>.github-mail{width:544px}</style>');
    expect(doc).toContain('<body class="github-mail" style="margin: 0">');
    expect(doc.match(/<body/g)).toHaveLength(1);
  });

  test('wraps long preformatted blocks instead of shrinking the whole message', () => {
    // Reduced from a real GitHub issue notification whose syntax-highlighted
    // Markdown block contains hundreds of spans and multi-hundred-character lines.
    const doc = buildMailSrcDoc(
      `<p>Comment</p><div class="highlight"><pre>${'<span>x</span>'.repeat(300)}</pre></div>`,
      true,
      'light',
    );
    expect(doc).toContain('pre { max-width:100%; white-space:pre-wrap; overflow-wrap:anywhere; }');
    expect(doc).toContain('<div class="highlight"><pre>');
  });

  test('keeps body padding inside the width used by whole-message scaling', () => {
    const doc = buildMailSrcDoc('<table width="640"><tr><td>wide</td></tr></table>', true, 'light');
    expect(doc).toContain('body { box-sizing:border-box;');
  });
});

describe('mailDocumentParts', () => {
  test('drops active body attributes and scripts', () => {
    const parts = mailDocumentParts(
      '<body class="mail" onclick="evil()"><script>evil()</script><p>Safe</p></body>',
    );
    expect(parts.bodyAttrs).toBe(' class="mail"');
    expect(parts.body).toBe('<p>Safe</p>');
  });
});

describe('overflow containment', () => {
  test('wraps one wide token locally instead of classifying the message as fixed-width', () => {
    document.body.innerHTML = `<p id="wide">${'x'.repeat(100)}</p>`;
    const wide = document.querySelector<HTMLElement>('#wide')!;
    Object.defineProperty(wide, 'scrollWidth', { value: 700 });
    containIsolatedOverflow(document, 320);
    expect(wide.style.overflowWrap).toBe('anywhere');
    expect(hasFixedWidthTemplate(document, 320)).toBe(false);
  });

  test('recognises an explicitly wide top-level newsletter table', () => {
    document.body.innerHTML =
      '<table width="600px"><tbody><tr><td>newsletter</td></tr></tbody></table>';
    const table = document.querySelector('table')!;
    Object.defineProperty(table, 'scrollWidth', { value: 600 });
    expect(hasFixedWidthTemplate(document, 320)).toBe(true);
  });
});

describe('declaresOwnBackground', () => {
  test('detects bgcolor attrs and colour-bearing background CSS', () => {
    expect(declaresOwnBackground('<table bgcolor="#fff">')).toBe(true);
    expect(declaresOwnBackground('<div style="background-color: #f5f5f5">')).toBe(true);
    expect(declaresOwnBackground('<div style="background: rgb(0,0,0)">')).toBe(true);
  });

  test('ignores url()-only and transparent backgrounds', () => {
    expect(declaresOwnBackground('<div style="background:url(http://x/bg.png)">')).toBe(false);
    expect(declaresOwnBackground('<div style="background-color: transparent">')).toBe(false);
    expect(declaresOwnBackground('<p>no background here</p>')).toBe(false);
  });
});

describe('declaresOwnTextColor', () => {
  test('detects CSS color and <font color>', () => {
    expect(declaresOwnTextColor('<span style="color:#888">x</span>')).toBe(true);
    expect(declaresOwnTextColor('<font color="gray">x</font>')).toBe(true);
  });

  test('does not mistake background-color for a text colour', () => {
    expect(declaresOwnTextColor('<div style="background-color:#fff">x</div>')).toBe(false);
    expect(declaresOwnTextColor('<p>plain</p>')).toBe(false);
  });
});
