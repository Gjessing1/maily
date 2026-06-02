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
import { env } from '../env.js';
import { updateFolderSyncState } from './folders.js';
import { extractHeaderValue, extractStructure, flagsFromSet, makeSnippet } from './parse.js';
import { findExistingId, touchKnownMessage, upsertMessage } from './store.js';

/** Local cache window — roughly one year by default (ARCHITECTURE §1). */
const CACHE_WINDOW_DAYS = env.cacheWindowDays;
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
    const result = await ctx.client.download(String(uid), part, { uid: true });
    if (!result?.content) return null;
    return await streamToString(result.content, result.meta?.charset);
  } catch (err) {
    ctx.log.warn(`failed to download part ${part} of uid ${uid}:`, (err as Error).message);
    return null;
  }
}

type FetchMessage = Awaited<ReturnType<ImapFlow['fetchOne']>>;

/**
 * The subset of a fetched message we keep in memory. We MUST fully drain the
 * `fetch()` iterator before issuing any `download()` calls: imapflow runs IMAP
 * commands serially, so a `download()` invoked while a `fetch()` response is
 * still streaming deadlocks (the download queues behind the fetch, the fetch
 * can't finish because we're awaiting the download) until the socket times out.
 * So we snapshot the plain fields here, let the iterator complete, then download.
 */
interface CapturedMessage {
  uid: number;
  envelope: Exclude<FetchMessage, false>['envelope'];
  bodyStructure: Exclude<FetchMessage, false>['bodyStructure'];
  internalDate: Exclude<FetchMessage, false>['internalDate'];
  flags: Set<string> | undefined;
  headers: Buffer | undefined;
  emailId: string | undefined;
  threadId: string | undefined;
}

function capture(msg: Exclude<FetchMessage, false>): CapturedMessage {
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

/** Assemble a ParsedMessage from a captured message + its downloaded body parts. */
async function toParsedMessage(ctx: SyncContext, msg: CapturedMessage): Promise<ParsedMessage> {
  const structure = extractStructure(msg.bodyStructure);
  const bodyText = structure.textPartId
    ? await downloadTextPart(ctx, msg.uid, structure.textPartId)
    : null;
  const bodyHtml = structure.htmlPartId
    ? await downloadTextPart(ctx, msg.uid, structure.htmlPartId)
    : null;

  const envelope = msg.envelope;
  const from = envelope?.from?.[0];
  const mapAddrs = (
    list: NonNullable<typeof envelope>['to'] | undefined,
  ): { name: string | null; address: string }[] =>
    (list ?? [])
      .filter((a): a is typeof a & { address: string } => Boolean(a.address))
      .map((a) => ({ name: a.name || null, address: a.address }));
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
    to: mapAddrs(envelope?.to),
    cc: mapAddrs(envelope?.cc),
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

    // Phase 1: drain the fetch fully (no other IMAP command may run mid-stream).
    const captured: CapturedMessage[] = [];
    for await (const msg of ctx.client.fetch(batch, FETCH_QUERY, { uid: true })) {
      captured.push(capture(msg as Exclude<FetchMessage, false>));
    }

    // Phase 2: connection is free now — persist. Dedup FIRST using identity from
    // the envelope (gm_msgid / message_id, already in hand), and only download body
    // parts for genuinely new messages. A re-sighting (e.g. an INBOX rebuild for a
    // message already stored via All Mail) just refreshes flags + folder mapping —
    // no body re-fetch — which is what keeps a full rebuild from taking hours.
    for (const msg of captured) {
      const gmMsgId = ctx.caps.gmail ? (msg.emailId ?? null) : null;
      const messageId = msg.envelope?.messageId ?? null;
      const knownId = findExistingId(ctx.accountId, gmMsgId, messageId);
      if (knownId) {
        touchKnownMessage(knownId, folder.id, msg.uid, flagsFromSet(msg.flags), folder.role);
        updated += 1;
        continue;
      }
      const parsed = await toParsedMessage(ctx, msg);
      const result = upsertMessage(ctx.accountId, folder.id, msg.uid, parsed, folder.role);
      if (result.inserted) insertedIds.push(result.id);
      else updated += 1;
    }
  }

  return { insertedIds, updated };
}

/**
 * Full sync of a folder's cache window. Used on first sight of a folder and when
 * UIDVALIDITY changes (cached UIDs become meaningless and must be rebuilt).
 *
 * Persists resync bookkeeping AS IT GOES so a process killed mid-sync resumes
 * incrementally on the next connect instead of rebuilding from scratch (the bug
 * behind a never-completing INBOX full sync re-running on every restart):
 *   - UIDVALIDITY is stored up front, so the next connect takes the incremental
 *     path rather than re-detecting a "first sight" and rebuilding again.
 *   - `lastUid` starts at the window's lower bound and advances per batch, so the
 *     incremental resume rescans only from the lowest UID not yet persisted —
 *     staying inside the cache window (never fetching all history from UID 1).
 * Re-sighting already-stored messages on resume is cheap (`fetchAndStore` dedups
 * before any body download), so the catch-up is fast.
 */
export async function fullSyncFolder(
  ctx: SyncContext,
  folder: FolderRow,
  state: { uidValidity: number; highestModseq: number | null; uidNext: number },
): Promise<StoreCounts> {
  const since = new Date(Date.now() - CACHE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const uids = ((await ctx.client.search({ since }, { uid: true })) || []).sort((a, b) => a - b);
  ctx.log.info(`full sync ${folder.path}: ${uids.length} message(s) in window`);

  // Resume floor: one below the lowest window UID (or just below UIDNEXT when the
  // window is empty). Stored before any body fetch so an interrupted run resumes
  // from the window bottom, never from UID 1.
  const floor = (uids[0] ?? state.uidNext) - 1;
  updateFolderSyncState(folder.id, {
    uidValidity: state.uidValidity,
    highestModseq: state.highestModseq,
    lastUid: floor,
  });

  const insertedIds: string[] = [];
  let updated = 0;
  for (let i = 0; i < uids.length; i += FETCH_BATCH) {
    const batch = uids.slice(i, i + FETCH_BATCH);
    const counts = await fetchAndStore(ctx, folder, batch);
    insertedIds.push(...counts.insertedIds);
    updated += counts.updated;
    // Advance the resume floor as each batch lands (UIDs are ascending).
    const batchTop = batch[batch.length - 1];
    if (batchTop !== undefined) updateFolderSyncState(folder.id, { lastUid: batchTop });
  }

  // Caught up: future incremental passes fetch only mail at/after UIDNEXT.
  updateFolderSyncState(folder.id, { lastUid: state.uidNext });
  return { insertedIds, updated };
}
