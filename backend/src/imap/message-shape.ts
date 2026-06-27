/**
 * Pure message-shaping: turn a fetched IMAP message into the in-memory snapshot we
 * keep (`CapturedMessage`) and then into the provider-agnostic `ParsedMessage` the
 * store persists (`buildParsedMessage`).
 *
 * This is the deterministic parse-shape layer, deliberately split out of `sync.ts`'s
 * fetch/download/sweep I/O orchestration: it needs no live IMAP connection, so it is
 * unit-testable on its own (see `sync.test.ts`) and the I/O paths read more cleanly
 * without the pure transform interleaved.
 */
import type { ImapFlow } from 'imapflow';
import type { Capabilities } from './connection.js';
import type { ParsedMessage } from './types.js';
import type { DerivedBody } from './source-parse.js';
import { extractHeaderValue, extractStructure, flagsFromSet, makeSnippet } from './parse.js';

export type FetchMessage = Awaited<ReturnType<ImapFlow['fetchOne']>>;

/**
 * The subset of a fetched message we keep in memory. We MUST fully drain the
 * `fetch()` iterator before issuing any `download()` calls: imapflow runs IMAP
 * commands serially, so a `download()` invoked while a `fetch()` response is
 * still streaming deadlocks (the download queues behind the fetch, the fetch
 * can't finish because we're awaiting the download) until the socket times out.
 * So we snapshot the plain fields here, let the iterator complete, then download.
 */
export interface CapturedMessage {
  uid: number;
  envelope: Exclude<FetchMessage, false>['envelope'];
  bodyStructure: Exclude<FetchMessage, false>['bodyStructure'];
  internalDate: Exclude<FetchMessage, false>['internalDate'];
  flags: Set<string> | undefined;
  headers: Buffer | undefined;
  emailId: string | undefined;
  threadId: string | undefined;
}

/**
 * Coerce an envelope/internal date to a valid Date, or null. imapflow's types promise a
 * Date, but a malformed `Date:` header can come through as the raw string (and a parsed
 * value can still be an Invalid Date). Either poisons the `timestamp_ms` DB write —
 * `value.getTime is not a function` — and because one bad message aborts a whole sweep
 * pass at the same UID forever, the sweep wedges and every folder after it starves.
 */
function toValidDate(value: Date | string | number | null | undefined): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function capture(msg: Exclude<FetchMessage, false>): CapturedMessage {
  return {
    uid: msg.uid,
    envelope: msg.envelope,
    bodyStructure: msg.bodyStructure,
    internalDate: msg.internalDate,
    flags: msg.flags,
    headers: msg.headers,
    emailId: msg.emailId,
    threadId: msg.threadId,
  };
}

/**
 * Assemble a ParsedMessage from a captured message + a supplied body. Attachment
 * metadata is always derived from the IMAP BODYSTRUCTURE (`extractStructure`) so
 * `part_ordinal` is identical on the live and bulk paths; only the text bodies vary
 * by source (downloaded parts on bulk, parsed from the `.eml` on live).
 *
 * Provider-agnostic save one branch: `gm_msgid`/`providerThreadId` are populated only
 * on Gmail (`caps.gmail`), so this reads `caps` rather than the full sync context.
 */
export function buildParsedMessage(
  caps: Capabilities,
  msg: CapturedMessage,
  body: DerivedBody,
  sourcePath: string | null,
  sourceBytes: number | null = null,
): ParsedMessage {
  const structure = extractStructure(msg.bodyStructure);
  const envelope = msg.envelope;
  const from = envelope?.from?.[0];
  const mapAddrs = (
    list: NonNullable<typeof envelope>['to'] | undefined,
  ): { name: string | null; address: string }[] =>
    (list ?? [])
      .filter((a): a is typeof a & { address: string } => Boolean(a.address))
      .map((a) => ({ name: a.name || null, address: a.address }));
  const internalDate = toValidDate(msg.internalDate);

  return {
    messageId: envelope?.messageId ?? null,
    gmMsgId: caps.gmail ? (msg.emailId ?? null) : null,
    providerThreadId: caps.gmail ? (msg.threadId ?? null) : null,
    inReplyTo: envelope?.inReplyTo ?? null,
    references: extractHeaderValue(msg.headers, 'references'),
    subject: envelope?.subject ?? null,
    fromName: from?.name ?? null,
    fromAddress: from?.address ?? null,
    to: mapAddrs(envelope?.to),
    cc: mapAddrs(envelope?.cc),
    snippet: makeSnippet(body.bodyText, body.bodyHtml, envelope?.subject ?? null),
    bodyText: body.bodyText,
    bodyHtml: body.bodyHtml,
    bodyCalendar: body.bodyCalendar,
    sourcePath,
    sourceBytes,
    sentAt: toValidDate(envelope?.date),
    receivedAt: internalDate,
    flags: flagsFromSet(msg.flags),
    attachments: structure.attachments,
  };
}
