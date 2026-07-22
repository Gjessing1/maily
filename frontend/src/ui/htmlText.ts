/**
 * Plain-text ⇄ HTML helpers for the rich-text composer. Outgoing mail ships both
 * an HTML part (from the editor) and a derived `text/plain` alternative so the
 * message renders for every client (CLAUDE.md / ROADMAP §3.7.B). Kept dependency-
 * free: the conversions run in the browser using the DOM parser.
 */

const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'BR',
  'LI',
  'UL',
  'OL',
  'BLOCKQUOTE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'TABLE',
  'TR',
  'HR',
  'PRE',
]);

/** Escape the five HTML-significant characters for safe insertion into markup. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Seed the editor from a plain-text prefill (reply/forward quote, signature).
 * Newlines become <br>; everything is escaped first so quoted `<`/`>` survive.
 */
export function plainTextToHtml(text: string): string {
  if (!text) return '';
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

/**
 * Derive a readable plain-text alternative from the editor's HTML. Walks the DOM
 * so block boundaries become newlines, list items get bullets/numbers, links
 * render as "text <url>", and blockquotes come back as `>`-prefixed lines
 * (RFC 3676 — how quoted history is expected to look in text/plain). Not a full
 * Markdown serializer — just enough that the text/plain part is legible.
 */
export function htmlToPlainText(html: string): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: string[] = [];
  const olCounter: number[] = [];

  const walk = (node: Node, listType: 'ul' | 'ol' | null): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        out.push((child.textContent ?? '').replace(/\s+/g, ' '));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as HTMLElement;
      const tag = el.tagName;

      if (tag === 'BR') {
        out.push('\n');
        continue;
      }
      if (tag === 'A') {
        const href = el.getAttribute('href');
        const text = el.textContent ?? '';
        out.push(href && href !== text ? `${text} <${href}>` : text);
        continue;
      }
      if (tag === 'LI') {
        if (listType === 'ol') {
          const depth = olCounter.length - 1;
          olCounter[depth] = (olCounter[depth] ?? 0) + 1;
          out.push(`${olCounter[depth]}. `);
        } else {
          out.push('- ');
        }
        walk(el, listType);
        out.push('\n');
        continue;
      }
      if (tag === 'BLOCKQUOTE') {
        // Serialize the quote on its own, then prefix every line. Nesting falls out
        // of the recursion: an inner quote arrives already `>`-prefixed and gets
        // another level on the way out ("> > …").
        const mark = out.length;
        walk(el, listType);
        // Collapse blank runs before prefixing — once every line starts with `>`
        // the global whitespace cleanup below can no longer see them.
        const inner = out
          .splice(mark)
          .join('')
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        const quoted = inner
          .split('\n')
          .map((l) => (l ? `> ${l}` : '>'))
          .join('\n');
        out.push('\n', quoted, '\n');
        continue;
      }
      if (tag === 'UL' || tag === 'OL') {
        if (tag === 'OL') olCounter.push(0);
        out.push('\n');
        walk(el, tag === 'OL' ? 'ol' : 'ul');
        if (tag === 'OL') olCounter.pop();
        continue;
      }

      walk(el, listType);
      if (BLOCK_TAGS.has(tag)) out.push('\n');
    }
  };

  walk(doc.body, null);
  return out
    .join('')
    .replace(/\u200b/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** True when the HTML carries no visible content (only whitespace / empty tags). */
export function isHtmlEmpty(html: string): boolean {
  return htmlToPlainText(html).trim().length === 0;
}

/**
 * Sanitize editor HTML for the wire: drop the zero-width caret markers the editor
 * inserts (see RichTextEditor) and collapse a body that's visually empty to ''.
 */
export function cleanEditorHtml(html: string): string {
  const stripped = html.replace(/\u200b/g, '');
  return isHtmlEmpty(stripped) ? '' : stripped;
}
