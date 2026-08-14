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
 * Body selection and decoding use mailsplit's streaming tree walk, so only selected
 * body leaves are buffered. Rebuild additionally uses `simpleParser` for RFC header
 * metadata one message at a time; bulk sync remains body-part-only.
 */
import { createReadStream } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Joiner, Splitter, Streamer, type MimeNode } from '@zone-eu/mailsplit';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import type { EmailAddress } from '@maily/shared';
import {
  materializeMimeBody,
  resolveMimeBody,
  type MimeBodyNode,
  type ResolvedMimeBody,
} from './body-resolver.js';
import { makeSnippet } from './parse.js';

export interface DerivedBody {
  bodyText: string | null;
  bodyHtml: string | null;
  /** Inline iCalendar (text/calendar) part for a calendar invite, when present. */
  bodyCalendar: string | null;
}

/** Parse RFC header/address metadata for rebuild without synthesising an HTML body. */
function parseEml(path: string): Promise<ParsedMail> {
  return simpleParser(createReadStream(path), { skipImageLinks: true, skipTextToHtml: true });
}

function devNull(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

interface SourceLeaf {
  ordinal: number;
  charset: string | null;
}

function relatedStartOf(node: MimeNode): string | null {
  const contentType = node.headers ? node.headers.getFirst('content-type') : '';
  const match = /(?:^|;)\s*start\s*=\s*(?:"<([^">]+)>"|<([^>]+)>|"([^"]+)"|([^;\s]+))/i.exec(
    contentType,
  );
  return match?.slice(1).find(Boolean) ?? null;
}

/** Build a lightweight MIME tree without buffering any body bytes. */
async function sourceBodyTree(path: string): Promise<MimeBodyNode<SourceLeaf> | undefined> {
  const byNode = new Map<MimeNode, MimeBodyNode<SourceLeaf>>();
  let root: MimeBodyNode<SourceLeaf> | undefined;
  let leafOrdinal = 0;
  const splitter = new Splitter();
  splitter.on('data', (chunk) => {
    if (chunk.type !== 'node') return;
    const node = chunk as unknown as MimeNode;
    const isLeaf = !node.multipart && !node.rfc822;
    const projected: MimeBodyNode<SourceLeaf> = {
      type: node.contentType || '',
      disposition: node.disposition || '',
      hasFilename: Boolean(node.filename),
      contentId: node.headers ? node.headers.getFirst('content-id').replace(/^<|>$/g, '') : null,
      relatedStart: relatedStartOf(node),
      value: isLeaf
        ? { ordinal: leafOrdinal++, charset: node.charset ? String(node.charset) : null }
        : undefined,
      children: [],
    };
    byNode.set(node, projected);
    if (node.parentNode) byNode.get(node.parentNode)?.children?.push(projected);
    else root = projected;
  });
  await pipeline(createReadStream(path), splitter, new Joiner(), devNull());
  return root;
}

function decodeText(bytes: Buffer, charset: string | null): string {
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return bytes.toString('utf-8');
  }
}

/** Stream-decode only the leaves selected by the shared MIME-tree resolver. */
async function readSourceSelection(
  path: string,
  selection: ResolvedMimeBody<SourceLeaf>,
): Promise<ResolvedMimeBody<string>> {
  const wanted = new Map<number, SourceLeaf>();
  for (const part of selection.display) wanted.set(part.value.ordinal, part.value);
  if (selection.plainFallback) wanted.set(selection.plainFallback.ordinal, selection.plainFallback);
  if (selection.calendar) wanted.set(selection.calendar.ordinal, selection.calendar);

  const decoded = new Map<number, string>();
  const reads: Promise<void>[] = [];
  let leafOrdinal = 0;
  let selectedOrdinal = -1;
  const streamer = new Streamer((node) => {
    if (node.multipart || node.rfc822) return false;
    const ordinal = leafOrdinal++;
    if (!wanted.has(ordinal)) return false;
    selectedOrdinal = ordinal;
    return true;
  });
  streamer.on('node', (data) => {
    const ordinal = selectedOrdinal;
    const chunks: Buffer[] = [];
    const read = new Promise<void>((resolve, reject) => {
      data.decoder.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      data.decoder.on('end', () => {
        decoded.set(
          ordinal,
          decodeText(Buffer.concat(chunks), wanted.get(ordinal)?.charset ?? null),
        );
        data.done();
        resolve();
      });
      data.decoder.on('error', (error) => {
        data.done();
        reject(error);
      });
    });
    reads.push(read);
  });
  await pipeline(createReadStream(path), new Splitter(), streamer, new Joiner(), devNull());
  await Promise.all(reads);

  return {
    display: selection.display.flatMap((part) => {
      const value = decoded.get(part.value.ordinal);
      return value == null ? [] : [{ kind: part.kind, value }];
    }),
    plainFallback: selection.plainFallback
      ? (decoded.get(selection.plainFallback.ordinal) ?? null)
      : null,
    calendar: selection.calendar ? (decoded.get(selection.calendar.ordinal) ?? null) : null,
  };
}

async function bodiesFromSource(path: string): Promise<DerivedBody> {
  const selected = resolveMimeBody(await sourceBodyTree(path));
  return materializeMimeBody(await readSourceSelection(path, selected));
}

/** Parse a saved `.eml` and return its text/plain, text/html and text/calendar bodies. */
export async function deriveBodyFromSource(path: string): Promise<DerivedBody> {
  return bodiesFromSource(path);
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
  bodyCalendar: string | null;
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
 * Mailparser supplies RFC metadata while the shared MIME resolver supplies bodies;
 * the `.eml` is canonical, so this is the authoritative derivation of the display
 * fields and snippet (which together feed FTS via the messages-table trigger).
 */
export async function parseSourceContent(path: string): Promise<RebuiltContent> {
  const [parsed, body] = await Promise.all([parseEml(path), bodiesFromSource(path)]);
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
    bodyCalendar: body.bodyCalendar,
    snippet: makeSnippet(body.bodyText, body.bodyHtml, parsed.subject ?? null),
  };
}
