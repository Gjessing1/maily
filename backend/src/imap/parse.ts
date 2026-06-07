/**
 * Pure parsing helpers — no IO. Turns IMAP BODYSTRUCTURE + fetched header/body
 * bytes into the pieces the store needs.
 *
 * Attachment bytes are NEVER pulled here: we enumerate attachment *metadata* from
 * BODYSTRUCTURE only and record the part id so the bytes can be fetched on demand
 * later (ARCHITECTURE §4 / KEY GOTCHA: no bulk eager attachment fetch during sync).
 */
import type { MessageStructureObject } from 'imapflow';
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
    attachments: [],
  };
  if (!root) return out;

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

    if (type === 'text/plain' && !out.textPartId) out.textPartId = partId;
    else if (type === 'text/html' && !out.htmlPartId) out.htmlPartId = partId;
    else if (type === 'text/calendar' && !out.calendarPartId) out.calendarPartId = partId;
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

/** Very light HTML→text for snippet/fallback use (not a full sanitizer). */
function htmlToText(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Build a short preview snippet from the available bodies. */
export function makeSnippet(text: string | null, html: string | null, max = 200): string | null {
  const source = text?.trim() || (html ? htmlToText(html) : '');
  if (!source) return null;
  const collapsed = source.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max).trimEnd()}…` : collapsed;
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
