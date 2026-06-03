/**
 * Derive the parsed body of a message from its on-disk raw `.eml` (ROADMAP §3.7.E).
 *
 * This is the body half of the "one download, one parse path" goal: the live path
 * captures full RFC822 once and reads `bodyText` / `bodyHtml` back out of it here
 * (replacing the separate text-part downloads), and the offline rebuild (E5) reuses
 * the same function. Attachment *metadata* still comes from the IMAP BODYSTRUCTURE
 * walk (`extractStructure`) so `part_ordinal` stays identical across the live and
 * bulk paths; only the text bodies are sourced from the `.eml` here.
 *
 * `simpleParser` does buffer the whole message, but this only runs for low-volume
 * new mail (live) or one message at a time (rebuild) — never the bulk sweep, which
 * stays body-only. The streaming, never-buffer extractor is reserved for the
 * on-demand attachment resolver (E4).
 */
import { createReadStream } from 'node:fs';
import { simpleParser } from 'mailparser';

export interface DerivedBody {
  bodyText: string | null;
  bodyHtml: string | null;
}

/** Parse a saved `.eml` and return its text/plain and text/html bodies. */
export async function deriveBodyFromSource(path: string): Promise<DerivedBody> {
  const parsed = await simpleParser(createReadStream(path), {
    skipImageLinks: true,
    skipTextToHtml: true,
  });
  const bodyText = parsed.text && parsed.text.trim() ? parsed.text : null;
  const bodyHtml = typeof parsed.html === 'string' && parsed.html.trim() ? parsed.html : null;
  return { bodyText, bodyHtml };
}
