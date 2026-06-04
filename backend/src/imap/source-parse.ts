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
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import type { EmailAddress } from '@maily/shared';
import { makeSnippet } from './parse.js';

export interface DerivedBody {
  bodyText: string | null;
  bodyHtml: string | null;
}

/** Parse a saved `.eml` with the body-only options shared by the live + rebuild paths. */
function parseEml(path: string): Promise<ParsedMail> {
  return simpleParser(createReadStream(path), { skipImageLinks: true, skipTextToHtml: true });
}

/** text/plain + text/html bodies from a parsed `.eml` (null when blank). */
function bodiesOf(parsed: ParsedMail): DerivedBody {
  const bodyText = parsed.text && parsed.text.trim() ? parsed.text : null;
  const bodyHtml = typeof parsed.html === 'string' && parsed.html.trim() ? parsed.html : null;
  return { bodyText, bodyHtml };
}

/** Parse a saved `.eml` and return its text/plain and text/html bodies. */
export async function deriveBodyFromSource(path: string): Promise<DerivedBody> {
  return bodiesOf(await parseEml(path));
}

/**
 * The message-content columns derivable from a raw `.eml` (ROADMAP §3.7.E rebuild).
 * These are the parsed cache *over* the canonical source — everything in here can be
 * regenerated from the `.eml` alone. Mailbox state NOT in RFC822 (flags, folder
 * membership, tombstones, `received_at`, the identity/thread keys) is deliberately
 * absent: the rebuild preserves it untouched.
 */
export interface RebuiltContent {
  subject: string | null;
  fromName: string | null;
  fromAddress: string | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  inReplyTo: string | null;
  references: string | null;
  sentAt: Date | null;
  bodyText: string | null;
  bodyHtml: string | null;
  snippet: string | null;
}

/** Flatten a mailparser AddressObject (or list of them) to our EmailAddress[]. */
function mapAddresses(field: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  if (!field) return [];
  const objs = Array.isArray(field) ? field : [field];
  return objs
    .flatMap((o) => o.value)
    .filter((a): a is typeof a & { address: string } => Boolean(a.address))
    .map((a) => ({ name: a.name || null, address: a.address }));
}

/**
 * Reparse a saved `.eml` into the full set of content columns the rebuild rewrites.
 * One `simpleParser` pass, the same parser the live path uses — the `.eml` is the
 * canonical content store, so this is the authoritative derivation of the display
 * fields, bodies and snippet (which together feed FTS via the messages-table trigger).
 */
export async function parseSourceContent(path: string): Promise<RebuiltContent> {
  const parsed = await parseEml(path);
  const body = bodiesOf(parsed);
  const from = parsed.from?.value.find((a) => a.address);
  const references = Array.isArray(parsed.references)
    ? parsed.references.join(' ')
    : (parsed.references ?? null);
  return {
    subject: parsed.subject ?? null,
    fromName: from?.name || null,
    fromAddress: from?.address ?? null,
    to: mapAddresses(parsed.to),
    cc: mapAddresses(parsed.cc),
    inReplyTo: parsed.inReplyTo ?? null,
    references,
    sentAt: parsed.date ?? null,
    bodyText: body.bodyText,
    bodyHtml: body.bodyHtml,
    snippet: makeSnippet(body.bodyText, body.bodyHtml),
  };
}
