/**
 * Streaming single-part extraction from a message's on-disk raw `.eml` (ROADMAP
 * §3.7.E, the local-source half of the unified attachment-byte resolver).
 *
 * Walks the `.eml` MIME tree node-by-node with `mailsplit`'s `Streamer` — a
 * tokenizer that hands back a *decoder stream* for the one selected node — and
 * pipes only that node's decoded body to disk. At no point is the whole message
 * (or any non-selected part) buffered in memory; contrast `simpleParser`, which
 * materialises every part. This is what lets the resolver serve attachment bytes
 * off the cached source with no IMAP round-trip and no memory blow-up.
 *
 * **Collision-free part matching.** The same shared classifier (`classifyPart`)
 * runs over both the IMAP BODYSTRUCTURE walk (`extractStructure`, which stamps
 * `part_ordinal`) and this raw-`.eml` walk, in identical DFS document order. So a
 * CID-less attachment is selected purely by its document-order ordinal — exact
 * regardless of duplicate filenames/sizes. Parts that carry a Content-ID match on
 * that instead (also exact). If a future edit moves the classifier predicate on
 * one side only, the two enumerations drift; the §3.7.E ordinal tripwire test
 * (`source-extract.test.ts`) guards exactly that.
 */
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Joiner, Splitter, Streamer } from '@zone-eu/mailsplit';
import type { MimeNode } from '@zone-eu/mailsplit';
import { classifyPart, type PartTraits } from './parse.js';

/** Which attachment to pull out of the `.eml`. Mirrors the stored attachment row. */
export interface PartTarget {
  /** Content-ID (without angle brackets) — the exact key when the part carries one. */
  contentId: string | null;
  /** Document-order index among *selected* parts — the key for CID-less attachments. */
  partOrdinal: number | null;
}

/** One selected (attachment) part as enumerated from a raw `.eml` walk. */
export interface SourcePart {
  /** Document-order index among selected parts — the `part_ordinal` counterpart. */
  partOrdinal: number;
  /** Content-ID without angle brackets, or null. */
  contentId: string | null;
  filename: string | null;
  mimeType: string | null;
}

/** What the extractor observed about the matched part (for a post-match sanity check). */
export interface ExtractedPart {
  /** Decoded byte length written to disk (NOT the BODYSTRUCTURE encoded estimate). */
  sizeBytes: number;
  filename: string | null;
  mimeType: string | null;
}

/**
 * Project a `mailsplit` leaf node onto the parser-agnostic `PartTraits` the shared
 * classifier consumes — the raw-`.eml` counterpart of the projection
 * `extractStructure` does for an imapflow BODYSTRUCTURE node. Keeping both
 * projections feeding the *one* `classifyPart` is what makes the two part
 * enumerations identical by construction.
 */
function traitsOf(node: MimeNode): PartTraits {
  const headers = node.headers || undefined;
  return {
    type: (node.contentType || '').toLowerCase(),
    disposition: (node.disposition || '').toLowerCase(),
    hasFilename: Boolean(node.filename),
    hasContentId: headers ? headers.hasHeader('content-id') : false,
  };
}

/**
 * Decide whether one `mailsplit` node is a *selected* attachment part, returning its
 * descriptor or null. Container nodes (multipart/*, message/rfc822) carry no leaf
 * body and are skipped here, exactly as `extractStructure` skips anything with child
 * nodes — so the running ordinal counts only real leaf parts. This is the single
 * point of node→selection truth shared by the streaming extractor and the
 * enumerator below; both therefore agree with `extractStructure` by construction.
 */
function selectPart(node: MimeNode): Omit<SourcePart, 'partOrdinal'> | null {
  if (node.multipart || node.rfc822) return null;
  if (!classifyPart(traitsOf(node)).selected) return null;
  const cidRaw = node.headers ? node.headers.getFirst('content-id') : '';
  return {
    contentId: cidRaw ? cidRaw.replace(/^<|>$/g, '') : null,
    filename: node.filename || null,
    mimeType: (node.contentType || '').toLowerCase() || null,
  };
}

/** A discarding sink so the Joiner's rebuilt byte stream has somewhere to drain. */
function devNull(): Writable {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
}

/**
 * Enumerate every selected (attachment) part of a raw `.eml` in document order,
 * stamping each with its `part_ordinal`. Used by the resolver's tripwire test to
 * assert this walk's enumeration matches `extractStructure`'s; only the headers are
 * parsed (the `Splitter`'s `node` events), never the bodies.
 */
export async function enumerateSourceParts(sourcePath: string): Promise<SourcePart[]> {
  const parts: SourcePart[] = [];
  const splitter = new Splitter();
  splitter.on('data', (chunk) => {
    if (chunk.type !== 'node') return;
    const sel = selectPart(chunk as unknown as MimeNode);
    if (sel) parts.push({ partOrdinal: parts.length, ...sel });
  });
  // The Splitter emits MIME objects; the Joiner turns them back into bytes so the
  // byte sink can drain them. We only consume the 'node' events above, never bodies.
  await pipeline(createReadStream(sourcePath), splitter, new Joiner(), devNull());
  return parts;
}

/**
 * Extract the single MIME part identified by `target` from the `.eml` at
 * `sourcePath`, streaming its decoded bytes to `destPath`. Returns what was written
 * (for `markAttachmentDownloaded` + the caller's sanity check), or `null` if no
 * part matched — e.g. a CID-less attachment whose `part_ordinal` is null (synced
 * before the column existed), letting the resolver fall through to IMAP.
 */
export async function extractPartFromSource(
  sourcePath: string,
  target: PartTarget,
  destPath: string,
): Promise<ExtractedPart | null> {
  await mkdir(dirname(destPath), { recursive: true });

  let selectedIndex = 0;
  let matched: Omit<SourcePart, 'partOrdinal'> | null = null;
  let writePromise: Promise<void> | null = null;

  const select = (node: MimeNode): boolean => {
    // Stop once we've claimed our part; later nodes can't change the answer.
    if (matched) return false;
    const sel = selectPart(node);
    if (!sel) return false;
    const ordinal = selectedIndex++;
    // Match on Content-ID when the target has one (exact), else on document-order
    // ordinal. Mirrors the resolver's "content_id first, ordinal for the rest".
    const isMatch =
      target.contentId != null
        ? sel.contentId === target.contentId
        : ordinal === target.partOrdinal;
    if (!isMatch) return false;
    matched = sel;
    return true;
  };

  const streamer = new Streamer(select);
  streamer.on('node', (data) => {
    // Pipe ONLY this node's decoded body to disk; `done()` lets the tokenizer carry
    // on past the selected node so the source stream drains to completion.
    writePromise = pipeline(data.decoder, createWriteStream(destPath));
    data.done();
  });

  await pipeline(createReadStream(sourcePath), new Splitter(), streamer, new Joiner(), devNull());
  const hit = matched as Omit<SourcePart, 'partOrdinal'> | null;
  if (!hit || !writePromise) return null;
  await writePromise;

  return { sizeBytes: statSync(destPath).size, filename: hit.filename, mimeType: hit.mimeType };
}
