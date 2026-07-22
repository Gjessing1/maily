/**
 * Split a message body into "what this person actually wrote" and "the quoted
 * history they replied on top of", so the reader can collapse the history behind
 * an Outlook-style `•••` chip instead of dumping ten screens of `>` lines.
 *
 * There is no standard marker for quoted history — every client invents its own
 * (Gmail: `blockquote.gmail_quote`; Outlook: a `border-top` divider div holding a
 * `From:/Sent:` header; Apple/Thunderbird: `blockquote[type=cite]`; plain text and
 * our own replies: `>`-prefixed lines under an "On … wrote:" attribution). So we
 * look for all of them, take the FIRST hit in document order, and treat everything
 * from there to the end of the body as history.
 *
 * Splitting is done on a parsed DOM (never string surgery) so the visible part
 * stays well-formed HTML. `DOMParser` documents have no browsing context, so
 * parsing untrusted sender HTML here loads nothing and runs nothing — the result
 * still goes through the sandboxed iframe + CSP in MailBody.
 */

/** Attribution lines that introduce a quote, across the clients/locales we see. */
const ATTRIBUTION = [
  /\bwrote\s*:\s*$/i, // en:  On Wed, May 20, 2026, Tore wrote:
  /\bskrev\s*:\s*$/i, // no/sv/da: Den 20. mai 2026 skrev Tore:
  /\bschrieb\s*:\s*$/i, // de
  /\ba écrit\s*:\s*$/i, // fr
  /\bescribió\s*:\s*$/i, // es
  /^-{2,}\s*(original message|forwarded message|opprinnelig melding)\s*-{2,}/i,
];

/** Header block that opens an Outlook-style quote ("From:" / "Fra:" / "Von:" …). */
const FORWARD_HEADER = /^\s*(from|fra|von|de|van|sender)\s*:/i;

/** Client-specific wrappers whose presence alone means "everything below is history". */
const QUOTE_SELECTORS = [
  'blockquote.gmail_quote',
  'div.gmail_quote',
  'div.gmail_quote_container',
  'blockquote[type="cite"]',
  'div#appendonsend',
  'div#divRplyFwdMsg',
  'div.moz-cite-prefix',
  'div.yahoo_quoted',
  'div#mail-editor-reference-message-container',
  'blockquote.protonmail_quote',
  'div.protonmail_quote',
].join(',');

/** An attribution line is a short one-liner; real prose ending in "wrote:" isn't. */
function isAttribution(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 200) return false;
  return ATTRIBUTION.some((re) => re.test(t));
}

/** A `>`-quoted line, allowing the nested `> > >` depth markers. */
function isQuotedLine(line: string): boolean {
  return /^\s*>/.test(line);
}

export type BodySplit = { visible: string; quoted: string };

/**
 * Collapse only when it earns its keep: there must be something left to show, and
 * the hidden part must be more than a stray line (otherwise the chip costs more
 * attention than the text it hides).
 */
function worthSplitting(visible: string, quoted: string): boolean {
  return visible.trim().length > 0 && quoted.trim().length >= 40;
}

/**
 * Plain-text bodies: cut at the first attribution line, or at the start of a run
 * of at least three `>` lines when the sender quoted without one.
 */
export function splitQuotedText(text: string): BodySplit {
  const lines = text.split('\n');
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (isAttribution(line)) {
      cut = i;
      break;
    }
    if (isQuotedLine(line) && lines.slice(i, i + 3).every(isQuotedLine)) {
      cut = i;
      break;
    }
  }
  if (cut < 0) return { visible: text, quoted: '' };

  const visible = lines.slice(0, cut).join('\n').replace(/\s+$/, '');
  const quoted = lines.slice(cut).join('\n').trim();
  if (!worthSplitting(visible, quoted)) return { visible: text, quoted: '' };
  return { visible, quoted };
}

/**
 * Move `node` and everything after it (walking up to `body`) into a fresh
 * container, leaving the visible part behind. Bottom-up, appending each level's
 * trailing siblings after the previous level's, keeps document order; the
 * ancestor wrappers themselves are flattened away, which is fine because the
 * history is self-contained blocks.
 */
function extractFrom(node: Node, body: Element, doc: Document): Element {
  const quoted = doc.createElement('div');
  const move = (from: Node | null) => {
    const take: Node[] = [];
    for (let n = from; n; n = n.nextSibling) take.push(n);
    for (const t of take) quoted.appendChild(t);
  };
  // The cut node itself and everything after it…
  let cur: Node | null = node.parentNode;
  move(node);
  // …then, at each level up, only what FOLLOWS the ancestor — the ancestor stays
  // put, since the visible reply lives in the part of it we left behind.
  while (cur && cur !== body && cur.parentNode) {
    move(cur.nextSibling);
    cur = cur.parentNode;
  }
  return quoted;
}

/**
 * Drop the blank run a cut leaves behind — the `<br><br>` and empty `<div>`s that
 * separated the reply from its quote. Without this the visible frame keeps measuring
 * (and reserving) a screenful of nothing above the `•••` chip. Recurses into the last
 * element so blanks nested inside a trailing wrapper go too; anything with text or a
 * visual (image/rule) stops the walk.
 */
function trimTrailingBlank(el: Element): void {
  for (let last = el.lastChild; last; last = el.lastChild) {
    const isBlankEl =
      last.nodeType === Node.ELEMENT_NODE &&
      !(last as Element).querySelector('img,hr,table') &&
      !(last.textContent ?? '').trim();
    const isBlankText = last.nodeType !== Node.ELEMENT_NODE && !(last.nodeValue ?? '').trim();
    if (!isBlankEl && !isBlankText) break;
    last.remove();
  }
  if (el.lastElementChild) trimTrailingBlank(el.lastElementChild);
}

/** First element matching a known client quote wrapper, in document order. */
function findQuoteElement(body: Element): Element | null {
  const marked = body.querySelector(QUOTE_SELECTORS);
  // Outlook desktop draws the divider as a plain `border-top` div wrapping the
  // "Fra: … Sendt: …" header, with the quoted body as following siblings.
  const dividers = Array.from(
    body.querySelectorAll<HTMLElement>('div[style*="border-top"]'),
  ).filter((d) => FORWARD_HEADER.test((d.textContent ?? '').trim().slice(0, 120)));
  const candidates = [marked, dividers[0]].filter((e): e is Element => !!e);
  // Both may match (a Gmail reply quoting an Outlook reply) — take the outer/earlier.
  return (
    candidates.sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    )[0] ?? null
  );
}

/**
 * Text-level quoting: an "On … wrote:" line or a run of `>` lines sitting in a
 * text node among `<br>`s (how a plain-text reply — including our own — looks
 * once escaped into HTML). Returns the node to cut at, splitting the text node
 * first if the attribution starts partway through it.
 */
function findQuoteText(body: Element, doc: Document): Node | null {
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let quotedRun = 0;
  let runStart: Text | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const value = n.nodeValue ?? '';
    if (!value.trim()) continue;

    const lines = value.split('\n');
    const idx = lines.findIndex(isAttribution);
    if (idx >= 0) {
      if (idx === 0) return n;
      const offset = lines.slice(0, idx).join('\n').length + 1;
      return n.splitText(offset);
    }

    if (isQuotedLine(value)) {
      runStart ??= n;
      if (++quotedRun >= 3) return runStart;
    } else {
      quotedRun = 0;
      runStart = null;
    }
  }
  return null;
}

/**
 * HTML bodies: find the quote boundary, lift the history out of the document, and
 * return both halves as HTML strings. Falls back to `{ visible: html, quoted: '' }`
 * whenever nothing is found or the split wouldn't be worth a toggle.
 */
export function splitQuotedHtml(html: string): BodySplit {
  if (typeof DOMParser === 'undefined') return { visible: html, quoted: '' };
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return { visible: html, quoted: '' };
  }
  const body = doc.body;
  if (!body) return { visible: html, quoted: '' };

  const start = findQuoteElement(body) ?? findQuoteText(body, doc);
  if (!start) return { visible: html, quoted: '' };

  const quotedEl = extractFrom(start, body, doc);
  // We rebuild each half from `body`, which would drop the `<head>` stylesheet the
  // sender's markup depends on (Outlook's MsoNormal rules live there). Re-attach it
  // to both halves — a `<style>` in the body applies just the same.
  const head = Array.from(doc.head?.querySelectorAll('style') ?? [])
    .map((s) => s.outerHTML)
    .join('');
  const quoted = head + quotedEl.innerHTML;
  trimTrailingBlank(body);
  const visible = head + body.innerHTML;

  // Measured on text, not markup: a quote of pure `<div><br></div>` padding is
  // nothing to hide, and a "visible" part that is only wrapper divs is nothing to show.
  if (!worthSplitting(body.textContent ?? '', quotedEl.textContent ?? '')) {
    return { visible: html, quoted: '' };
  }
  return { visible, quoted };
}
