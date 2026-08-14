/**
 * Pure parsing helpers — no IO. Turns IMAP BODYSTRUCTURE + fetched header/body
 * bytes into the pieces the store needs.
 *
 * Attachment bytes are NEVER pulled here: we enumerate attachment *metadata* from
 * BODYSTRUCTURE only and record the part id so the bytes can be fetched on demand
 * later (ARCHITECTURE §4 / KEY GOTCHA: no bulk eager attachment fetch during sync).
 */
import { decodeHTML } from 'entities';
import * as cheerio from 'cheerio';
import type { MessageStructureObject } from 'imapflow';
import { resolveMimeBody, type MimeBodyNode } from './body-resolver.js';
import type { MessageFlags, ParsedAttachment } from './types.js';

export interface ExtractedStructure {
  /** BODYSTRUCTURE part id of the best text/plain body, if any. */
  textPartId: string | null;
  /** BODYSTRUCTURE part id of the best text/html body, if any. */
  htmlPartId: string | null;
  /**
   * BODYSTRUCTURE part id of an inline text/calendar part (a calendar invite's
   * VEVENT block), if any. Only the inline form (no filename / disposition) lands
   * here; a `.ics` *attachment* is classified as an attachment and fetched lazily.
   */
  calendarPartId: string | null;
  /** MIME-selected display parts, preserving independent multipart/mixed branches. */
  displayParts: Array<{ kind: 'plain' | 'html'; partId: string }>;
  attachments: ParsedAttachment[];
}

function filenameOf(node: MessageStructureObject): string | null {
  return node.dispositionParameters?.filename ?? node.parameters?.name ?? null;
}

/** The leaf-part attributes the shared classifier needs — parser-agnostic. */
export interface PartTraits {
  /** Lowercased MIME type, e.g. `image/png` (empty string if unknown). */
  type: string;
  /** Lowercased Content-Disposition, e.g. `attachment` / `inline` (empty if none). */
  disposition: string;
  /** Whether the part declares a filename (disposition filename or `name` param). */
  hasFilename: boolean;
  /** Whether the part carries a Content-ID (the inline-CID marker). */
  hasContentId: boolean;
}

/**
 * THE single attachment classifier (ROADMAP §3.7.E). Both the IMAP BODYSTRUCTURE
 * walk (`extractStructure`) and the local-source `.eml` walk (the unified attachment
 * resolver) run *this one* predicate over their respective trees, so their part
 * enumerations — and therefore `part_ordinal` — are identical **by construction**.
 * Any edit to what counts as an attachment MUST live here so both walks follow it.
 */
export function classifyPart(t: PartTraits): { selected: boolean; isInline: boolean } {
  const isInline = t.disposition === 'inline' && t.hasContentId;
  const isAttachment = t.disposition === 'attachment' || (t.hasFilename && !isInline);
  const selected = isAttachment || (isInline && !t.type.startsWith('text/'));
  return { selected, isInline };
}

/** Walk the BODYSTRUCTURE tree, collecting body part ids and attachment metadata. */
export function extractStructure(root: MessageStructureObject | undefined): ExtractedStructure {
  const out: ExtractedStructure = {
    textPartId: null,
    htmlPartId: null,
    calendarPartId: null,
    displayParts: [],
    attachments: [],
  };
  if (!root) return out;

  const toBodyNode = (node: MessageStructureObject): MimeBodyNode<string> => ({
    type: node.type || '',
    disposition: node.disposition,
    hasFilename: Boolean(filenameOf(node)),
    contentId: node.id ?? null,
    relatedStart: node.parameters?.start ?? null,
    value: node.childNodes?.length ? undefined : (node.part ?? '1'),
    children: node.childNodes?.map(toBodyNode),
  });
  const selectedBody = resolveMimeBody(toBodyNode(root));
  out.displayParts = selectedBody.display.map((part) => ({ kind: part.kind, partId: part.value }));
  out.textPartId = selectedBody.plainFallback;
  out.htmlPartId = selectedBody.display.find((part) => part.kind === 'html')?.value ?? null;
  out.calendarPartId = selectedBody.calendar;

  const visit = (node: MessageStructureObject): void => {
    if (node.childNodes && node.childNodes.length > 0) {
      node.childNodes.forEach(visit);
      return;
    }

    const type = (node.type || '').toLowerCase();
    const filename = filenameOf(node);
    // A non-multipart message has no `part`; its single body is part "1".
    const partId = node.part ?? '1';
    const contentId = node.id ? node.id.replace(/^<|>$/g, '') : null;

    const { selected, isInline } = classifyPart({
      type,
      disposition: (node.disposition || '').toLowerCase(),
      hasFilename: Boolean(filename),
      hasContentId: Boolean(node.id),
    });

    if (selected) {
      // partOrdinal is just the document-order push index (DFS): the local-source
      // resolver reproduces it by walking the .eml with the same classifier.
      out.attachments.push({
        filename,
        mimeType: type || null,
        sizeBytes: node.size ?? null,
        imapPartId: partId,
        partOrdinal: out.attachments.length,
        contentId,
        isInline,
      });
      return;
    }
  };

  visit(root);
  return out;
}

/** Translate an IMAP flag Set into our boolean flags. */
export function flagsFromSet(flags: Set<string> | undefined): MessageFlags {
  const has = (f: string): boolean => Boolean(flags?.has(f));
  return {
    seen: has('\\Seen'),
    flagged: has('\\Flagged'),
    answered: has('\\Answered'),
    draft: has('\\Draft'),
  };
}

/**
 * Zero-width / invisible characters that senders pad previews with (the classic
 * `&zwnj;&nbsp;` preheader-spacer hack) plus soft hyphens and bidi controls. They
 * carry no preview value and render as gaps or tofu in a one-line snippet.
 */
const INVISIBLE_CHARS_RE =
  // combining grapheme joiner leads the class (placed after another char in a
  // class, it trips ESLint no-misleading-character-class); then soft hyphen, Arabic
  // letter mark, Mongolian vowel separator, zero-widths + bidi marks, bidi embeds,
  // word joiner…invisible plus, BOM/zero-width no-break space
  /[\u034F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

const BLOCK_TAGS =
  'address,article,aside,blockquote,div,dl,dt,dd,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,ol,p,section,table,tbody,td,tfoot,th,thead,tr,ul';

/**
 * Deterministic, no-network visible-text extraction for the representation the
 * reader displays. It handles the hiding techniques used by email preheaders and
 * preserves useful block/line boundaries plus image alternative text.
 */
export function htmlToVisibleText(html: string): string {
  const withoutHiddenComments = html.replace(/<!--[\s\S]*?-->/g, ' ');
  const $ = cheerio.load(withoutHiddenComments);

  // Apply simple author stylesheet rules whose declaration makes the whole matched
  // node invisible. This covers the common `.preheader { display:none }` pattern;
  // complex/media-query selectors that Cheerio cannot evaluate are ignored safely.
  $('style').each((_index, style) => {
    const css = $(style)
      .text()
      .replace(/\/\*[\s\S]*?\*\//g, '');
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const declarations = rule[2] ?? '';
      if (
        !/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|mso-hide\s*:\s*all)\b/i.test(
          declarations,
        )
      )
        continue;
      for (const selector of (rule[1] ?? '').split(',')) {
        try {
          $(selector.trim()).remove();
        } catch {
          // Unsupported selector: deterministic best effort, never fail ingestion.
        }
      }
    }
  });

  $('script,style,head,xml,template,noscript,[hidden],[aria-hidden="true" i]').remove();
  $('*').each((_index, element) => {
    const el = $(element);
    const style = el.attr('style') ?? '';
    const hiddenByStyle =
      /(?:^|;)\s*display\s*:\s*none\b/i.test(style) ||
      /(?:^|;)\s*visibility\s*:\s*(?:hidden|collapse)\b/i.test(style) ||
      /(?:^|;)\s*mso-hide\s*:\s*all\b/i.test(style) ||
      /(?:^|;)\s*opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)/i.test(style) ||
      (/(?:^|;)\s*(?:max-)?height\s*:\s*0(?:px)?\b/i.test(style) &&
        /(?:^|;)\s*overflow\s*:\s*hidden\b/i.test(style));
    const width = el.attr('width');
    const height = el.attr('height');
    const zeroSized =
      width != null &&
      height != null &&
      /^(?:0|0px)$/.test(width.trim()) &&
      /^(?:0|0px)$/.test(height.trim()) &&
      el.is('img,iframe,object,embed');
    if (hiddenByStyle || zeroSized) el.remove();
  });

  $('img').each((_index, image) => {
    const alt = $(image).attr('alt')?.trim();
    $(image).replaceWith(alt ? ` ${alt} ` : ' ');
  });
  $('br').replaceWith('\n');
  $(BLOCK_TAGS).each((_index, element) => {
    $(element).prepend('\n').append('\n');
  });
  return $.root()
    .text()
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/**
 * True if a string carries a recognizable HTML tag. Used to spot a `text/plain`
 * part that's actually polluted with markup — some senders (e.g. Eloqua) leak an
 * `<html …>`/preheader tag into the plaintext alternative, which would otherwise
 * surface verbatim in the inbox snippet. Matches a known tag name so prose with a
 * stray `a < b` or an `<email@addr>` doesn't trip it.
 */
function containsHtmlTag(s: string): boolean {
  return /<\/?(?:!doctype|html|head|body|meta|title|style|div|span|table|tr|td|th|tbody|thead|p|br|hr|a|img|ul|ol|li|h[1-6]|font|center|b|strong|i|em)\b[^>]*>/i.test(
    s,
  );
}

/**
 * Some bulk-mail generators label a CSS stylesheet as `text/plain`. The common
 * Outlook reset starts `#outlook a { padding:0; }`; treating that as prose makes
 * the inbox preview show CSS instead of the message. Some generators put a title
 * before the CSS, so distinctive signatures or several early declaration blocks
 * are treated as a high-confidence stylesheet signal.
 */
function looksLikeStylesheet(s: string): boolean {
  const start = s.trimStart().slice(0, 1_500);
  // A few generators prepend a title before dumping the stylesheet into their
  // alleged text/plain part (real Dustin examples start "Velkommen til Dustin!"
  // immediately followed by `#outlook`, while their account-confirmation mail
  // starts with a title then `@font-face`). Do not require CSS to be byte zero.
  // Two declaration blocks are a strong generic signal; the Outlook/font-face
  // signatures are sufficiently distinctive to stand on their own.
  if (/(?:#outlook\s+a\s*\{|@font-face\s*\{)/i.test(start)) return true;
  const declarations = start.match(
    /(?:^|[}\r\n])\s*(?:[.#]?[a-z][\w.-]*(?:\s*,\s*[.#]?[a-z][\w.-]*)*|(?:body|table|td|img|a|p)(?:[\s.#:[>+~][^{]*)?)\s*\{[^}]*:[^}]*\}/gi,
  );
  return (declarations?.length ?? 0) >= 2;
}

/**
 * Strip mailparser's plaintext link artifacts. When it derives a `text/plain`
 * alternative from HTML, an `<a href="url">label</a>` becomes `label [url]` and a
 * bare/auto link becomes `[url]`. Those bracketed URLs (often long tracking links)
 * are noise in a one-line preview, so drop them along with the space in front.
 */
function stripLinkArtifacts(s: string): string {
  return s.replace(/[ \t]*\[(?:https?:\/\/|mailto:)[^\]]*\]/gi, '');
}

/**
 * Drop bare URLs from a preview. Marketing `text/plain` alternatives are largely a
 * link dump — a 300-char encrypted tracking URL sits between the preheader spacers
 * and the first real words ("…qs=eyJkZWtJZCI6… Se nettversjonen"), so an unfiltered
 * preview is one long opaque token. Never returns empty: a body that is *only* a
 * link keeps the link rather than losing its preview entirely.
 */
function stripBareUrls(s: string): string {
  const stripped = s.replace(/[ \t]*(?:https?:\/\/|www\.)\S+/gi, '').trim();
  return stripped || s;
}

/**
 * Drop bracket husks left empty by URL stripping. Markdown-ish plaintext parts
 * wrap every link as `label (\n https://… \n)`, so removing the URL leaves the
 * preview reading "Av Nikolai Toverud ( )". Only fires on a genuinely empty pair,
 * so real parentheticals are untouched.
 */
function stripEmptyBrackets(s: string): string {
  return s.replace(/[ \t]*[([{]\s*[)\]}]/g, '');
}

/**
 * Strip ASCII-art rules and preheader padding. Newsletters rule off their sections
 * with `*********` (ConvertKit), and senders pad the preheader with a repeated
 * filler token so the client's own preview stops there — Esri's plaintext part
 * carries 100+ copies of "?? " (their HTML spacer, transcoded), which was the
 * entire visible snippet. Never returns empty: a body that is only a rule keeps it.
 */
function stripPaddingRuns(s: string): string {
  const stripped = s
    // A run of one repeated punctuation char: ***** ----- ===== ~~~~~ _____.
    // Four or more, so ordinary prose ellipses survive.
    .replace(/([^\p{L}\p{N}\s\p{Extended_Pictographic}])\1{3,}/gu, ' ')
    // Three or more whitespace-separated punctuation-only tokens: "? ? ?", "?? ?? ??",
    // "• • •". Prose never strings that many wordless tokens together.
    .replace(/(?:(?<=^|\s)[^\p{L}\p{N}\s\p{Extended_Pictographic}]{1,3}(?=\s|$)\s*){3,}/gu, ' ')
    .trim();
  return stripped || s;
}

/**
 * Drop a leading copy of the subject from a body preview. Newsletters routinely
 * repeat the subject as the first visible line of the body (e.g. Self-Host Weekly),
 * which otherwise makes the inbox show the subject twice instead of the preheader.
 * Only fires on a confident, reasonably long exact prefix match, and never returns
 * an empty string (a body that is *only* the subject keeps the subject).
 */
function stripLeadingSubject(body: string, subject: string | null): string {
  const subj = subject?.replace(/\s+/g, ' ').trim();
  if (!subj || subj.length < 8 || !body.startsWith(subj)) return body;
  const rest = body
    .slice(subj.length)
    .replace(/^[\s|>·•\-–—:]+/, '')
    .trim();
  return rest || body;
}

/** Build a short preview snippet from the available bodies. */
export function makeSnippet(
  text: string | null,
  html: string | null,
  subject: string | null = null,
  max = 200,
): string | null {
  const plain = text?.trim();
  // The inbox preview must describe what the reader displays. A selected HTML body
  // therefore wins over its plaintext alternative; plaintext is only the fallback
  // when HTML has no usable visible text.
  // A clean-looking `text/plain` part still gets an entity decode: senders derive the
  // plaintext alternative from their HTML and leave the `&zwnj;` preheader spacers in
  // as literal text, which filled the whole preview with "&zwnj; &zwnj; &zwnj;…".
  // Decoded, they become zero-width joiners that INVISIBLE_CHARS_RE drops below.
  const fromPlain = plain
    ? containsHtmlTag(plain)
      ? htmlToVisibleText(plain)
      : looksLikeStylesheet(plain) && html
        ? ''
        : decodeHTML(plain)
    : '';
  const fromHtml = html ? htmlToVisibleText(html) : '';
  const source = fromHtml.trim() || fromPlain.trim();
  if (!source) return null;
  const cleaned = stripEmptyBrackets(stripBareUrls(stripLinkArtifacts(source)))
    .replace(INVISIBLE_CHARS_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Padding runs are matched against the whitespace-collapsed text, and leave gaps of
  // their own behind, so collapse once more afterwards.
  const collapsed = stripPaddingRuns(cleaned).replace(/\s+/g, ' ').trim();
  const deduped = stripLeadingSubject(collapsed, subject);
  if (!deduped) return null;
  if (deduped.length <= max) return deduped;
  // Cut on a code-point boundary. `slice` counts UTF-16 units, so a max landing inside
  // an emoji's surrogate pair leaves a lone high surrogate — which is not valid UTF-8,
  // comes back out of SQLite as U+FFFD, and so never equals the recomputed snippet
  // (the backfill rewrote those rows on every single boot).
  const cut = deduped.slice(0, max).replace(/[\uD800-\uDBFF]$/, '');
  return `${cut.trimEnd()}…`;
}

/** Extract a single header value (handling folded continuation lines) from raw header bytes. */
export function extractHeaderValue(headers: Buffer | undefined, name: string): string | null {
  if (!headers) return null;
  const text = headers.toString('utf-8');
  const re = new RegExp(`^${name}:[ \\t]*([\\s\\S]*?)(?:\\r?\\n(?![ \\t]))`, 'im');
  const match = re.exec(`${text}\n`);
  const value = match?.[1];
  if (!value) return null;
  return value.replace(/\r?\n[ \t]+/g, ' ').trim();
}
