/**
 * Folder synchronisation: fetch messages, parse them, persist via the store.
 *
 * What we pull over IMAP per message: envelope, flags, BODYSTRUCTURE, internal
 * date, the References header, and — separately and only when present — the
 * text/plain and text/html body parts. We deliberately do NOT fetch full message
 * source, because that would drag attachment bytes over the wire in bulk
 * (ARCHITECTURE §4 / KEY GOTCHA). Attachment bytes are fetched on demand later.
 */
import type { FetchQueryObject, ImapFlow } from 'imapflow';
import type { Logger } from '../logger.js';
import type { Capabilities } from './connection.js';
import type { FolderRow } from './folders.js';
import type { ParsedMessage } from './types.js';
import { extractHeaderValue, extractStructure, flagsFromSet, makeSnippet } from './parse.js';
import { upsertMessage } from './store.js';

/** Default local cache window — roughly one year (ARCHITECTURE §1). */
const CACHE_WINDOW_DAYS = Number(process.env.MAILY_CACHE_WINDOW_DAYS ?? '365');
const FETCH_BATCH = 100;

export interface SyncContext {
  client: ImapFlow;
  accountId: string;
  caps: Capabilities;
  log: Logger;
}

/** The FETCH query shape we use everywhere — header-and-structure only, no source. */
const FETCH_QUERY: FetchQueryObject = {
  uid: true,
  flags: true,
  envelope: true,
  bodyStructure: true,
  internalDate: true,
  size: true,
  threadId: true,
  headers: ['references'],
};

async function streamToString(
  stream: NodeJS.ReadableStream,
  charset: string | undefined,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const buf = Buffer.concat(chunks);
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch {
    return buf.toString('utf-8');
  }
}

/** Download a single (small) text body part, transfer-decoded by imapflow. */
async function downloadTextPart(
  ctx: SyncContext,
  uid: number,
  part: string,
): Promise<string | null> {
  try {
    const { meta, content } = await ctx.client.download(String(uid), part, { uid: true });
    return await streamToString(content, meta.charset);
  } catch (err) {
    ctx.log.warn(`failed to download part ${part} of uid ${uid}:`, (err as Error).message);
    return null;
  }
}

type FetchMessage = Awaited<ReturnType<ImapFlow['fetchOne']>>;

/** Assemble a ParsedMessage from a fetched message + its downloaded body parts. */
async function toParsedMessage(
  ctx: SyncContext,
  msg: Exclude<FetchMessage, false>,
): Promise<ParsedMessage> {
  const structure = extractStructure(msg.bodyStructure);
  const bodyText = structure.textPartId
    ? await downloadTextPart(ctx, msg.uid, structure.textPartId)
    : null;
  const bodyHtml = structure.htmlPartId
    ? await downloadTextPart(ctx, msg.uid, structure.htmlPartId)
    : null;

  const envelope = msg.envelope;
  const from = envelope?.from?.[0];
  const internalDate =
    msg.internalDate instanceof Date
      ? msg.internalDate
      : msg.internalDate
        ? new Date(msg.internalDate)
        : null;

  return {
    messageId: envelope?.messageId ?? null,
    gmMsgId: ctx.caps.gmail ? (msg.emailId ?? null) : null,
    providerThreadId: ctx.caps.gmail ? (msg.threadId ?? null) : null,
    inReplyTo: envelope?.inReplyTo ?? null,
    references: extractHeaderValue(msg.headers, 'references'),
    subject: envelope?.subject ?? null,
    fromName: from?.name ?? null,
    fromAddress: from?.address ?? null,
    snippet: makeSnippet(bodyText, bodyHtml),
    bodyText,
    bodyHtml,
    sentAt: envelope?.date ?? null,
    receivedAt: internalDate,
    flags: flagsFromSet(msg.flags),
    attachments: structure.attachments,
  };
}

export interface StoreCounts {
  /** Internal ids of newly inserted messages (for live new-mail signals). */
  insertedIds: string[];
  updated: number;
}

/** Fetch a set of UIDs and persist them into the folder. */
export async function fetchAndStore(
  ctx: SyncContext,
  folder: FolderRow,
  uids: number[],
): Promise<StoreCounts> {
  const insertedIds: string[] = [];
  let updated = 0;

  for (let i = 0; i < uids.length; i += FETCH_BATCH) {
    const batch = uids.slice(i, i + FETCH_BATCH);
    for await (const msg of ctx.client.fetch(batch, FETCH_QUERY, { uid: true })) {
      const parsed = await toParsedMessage(ctx, msg as Exclude<FetchMessage, false>);
      const result = upsertMessage(ctx.accountId, folder.id, msg.uid, parsed);
      if (result.inserted) insertedIds.push(result.id);
      else updated += 1;
    }
  }

  return { insertedIds, updated };
}

/**
 * Full sync of a folder's cache window. Used on first sight of a folder and when
 * UIDVALIDITY changes (cached UIDs become meaningless and must be rebuilt).
 */
export async function fullSyncFolder(ctx: SyncContext, folder: FolderRow): Promise<StoreCounts> {
  const since = new Date(Date.now() - CACHE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const uids = (await ctx.client.search({ since }, { uid: true })) || [];
  ctx.log.info(`full sync ${folder.path}: ${uids.length} message(s) in window`);
  return fetchAndStore(ctx, folder, uids);
}
