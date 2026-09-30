/**
 * The billing export feed: every message the invoice enricher classified as an invoice
 * or receipt, in the order maily (re)classified it, for another app on the host
 * (Moneta) to import. Read-only, and it trusts a ledger row by the same bar as
 * `facts-read.ts` (ok + current version + readable shape).
 *
 * It pages on the ledger row's `(updated_at, id)`, not on `received_at`: classification
 * lands after arrival (and again when the enricher's version is bumped), so a cursor on
 * arrival time would skip mail enriched after the consumer had moved past it. A re-run
 * re-emits the message with its new facts; the consumer upserts on the message id.
 */
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type {
  BillingExportDocumentDto,
  BillingExportItemDto,
  BillingExportPageDto,
} from '@maily/shared';
import { db } from '../db/client.js';
import { attachments, enrichments, messages } from '../db/schema.js';
import { readInvoice } from './facts-read.js';
import { enricherByName } from './registry.js';

/**
 * Rows newer than this are held back. A row's stamp is taken just before its commit,
 * and the pipeline writes from a worker thread, so a row can commit with a stamp
 * slightly older than one a reader has already paged past. Waiting until a stamp
 * settles closes that gap.
 */
export const SETTLE_MS = 5_000;

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;

interface Cursor {
  updatedAt: number;
  id: string;
}

/** Cursors are `<updated_at ms>.<ledger row id>`; opaque to the consumer. */
export function parseCursor(raw: string): Cursor | null {
  const match = /^(\d+)\.([0-9a-f-]{36})$/i.exec(raw);
  if (!match) return null;
  return { updatedAt: Number(match[1]), id: match[2]! };
}

function formatCursor(cursor: Cursor): string {
  return `${cursor.updatedAt}.${cursor.id}`;
}

function toDocuments(
  refs: { attachmentId: string; kind: BillingExportDocumentDto['kind'] }[],
  byId: Map<string, typeof attachments.$inferSelect>,
  messageId: string,
): BillingExportDocumentDto[] {
  const docs: BillingExportDocumentDto[] = [];
  for (const ref of refs) {
    const att = byId.get(ref.attachmentId);
    // A reference to an attachment of another message (or one since removed) can't be
    // fetched through the message route, so it isn't offered.
    if (!att || att.messageId !== messageId) continue;
    docs.push({
      attachmentId: att.id,
      kind: ref.kind,
      filename: att.filename,
      mimeType: att.mimeType,
      sizeBytes: att.sizeBytes,
    });
  }
  return docs;
}

export function billingExportPage(opts: {
  after: string | null;
  limit: number;
  now?: number;
}): BillingExportPageDto {
  const after = opts.after ? parseCursor(opts.after) : null;
  const version = enricherByName('invoice')?.version ?? -1;
  const settledBefore = new Date((opts.now ?? Date.now()) - SETTLE_MS);

  const conditions = [
    eq(enrichments.enricher, 'invoice'),
    eq(enrichments.status, 'ok'),
    eq(enrichments.enricherVersion, version),
    lte(enrichments.updatedAt, settledBefore),
    sql`CASE WHEN json_valid(${enrichments.result})
      THEN json_extract(${enrichments.result}, '$.invoice.kind') END IN ('invoice', 'receipt')`,
    // A purged shell has no bytes left to hand over. A trashed message still counts:
    // binning the mail doesn't mean the receipt is unwanted.
    isNull(messages.purgedAt),
  ];
  if (after) {
    const at = new Date(after.updatedAt);
    const cursorCondition = or(
      gt(enrichments.updatedAt, at),
      and(eq(enrichments.updatedAt, at), gt(enrichments.id, after.id)),
    );
    if (cursorCondition) conditions.push(cursorCondition);
  }

  const rows = db
    .select({
      rowId: enrichments.id,
      updatedAt: enrichments.updatedAt,
      result: enrichments.result,
      messageId: messages.id,
      accountId: messages.accountId,
      subject: messages.subject,
      fromName: messages.fromName,
      fromAddress: messages.fromAddress,
      receivedAt: messages.receivedAt,
      deletedAt: messages.deletedAt,
    })
    .from(enrichments)
    .innerJoin(messages, eq(messages.id, enrichments.messageId))
    .where(and(...conditions))
    .orderBy(asc(enrichments.updatedAt), asc(enrichments.id))
    .limit(opts.limit + 1)
    .all();

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;

  const messageIds = page.map((row) => row.messageId);
  const byId = new Map<string, typeof attachments.$inferSelect>();
  if (messageIds.length > 0) {
    const atts = db
      .select()
      .from(attachments)
      .where(inArray(attachments.messageId, messageIds))
      .all();
    for (const att of atts) byId.set(att.id, att);
  }

  const items: BillingExportItemDto[] = [];
  let cursor = after ? formatCursor(after) : null;
  for (const row of page) {
    const updatedAt = row.updatedAt?.getTime() ?? 0;
    // The cursor moves past every scanned row, including one whose JSON doesn't pass
    // the shape check, so a bad row can't pin the feed.
    cursor = formatCursor({ updatedAt, id: row.rowId });
    const invoice = readInvoice(parseResult(row.result));
    if (!invoice) continue;
    items.push({
      messageId: row.messageId,
      accountId: row.accountId,
      kind: invoice.kind,
      subject: row.subject,
      from: row.fromAddress ? { name: row.fromName, address: row.fromAddress } : null,
      receivedAt: row.receivedAt ? row.receivedAt.toISOString() : null,
      classifiedAt: new Date(updatedAt).toISOString(),
      trashed: row.deletedAt !== null,
      documents: toDocuments(invoice.documents, byId, row.messageId),
      kids: invoice.kids,
      accounts: invoice.accounts,
      ibans: invoice.ibans,
      amount: invoice.amount
        ? { value: invoice.amount.value, currency: invoice.amount.currency }
        : null,
      dueDate: invoice.dueDate,
    });
  }
  return { items, cursor, hasMore };
}

function parseResult(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
