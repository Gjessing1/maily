/**
 * The one read path from the `enrichments` ledger to the features that use it. Every
 * consumer used to `JSON.parse(raw) as T` against types imported from the enricher
 * implementation; this module does that once, and trusts a row only when:
 *
 *   - it finished (`status = 'ok'`),
 *   - the enricher that wrote it is registered and still at that **version** — an old
 *     version's output is not what the current types describe (the `package` v1 rows
 *     predate its check-digit validation), and the pipeline re-runs stale rows on its
 *     own (`backfillStaleVersions`), so they turn current rather than disappear,
 *   - its JSON parses and has the expected shape.
 *
 * Anything else reads as "no facts", never as an error: a bad ledger row must not break
 * the reader.
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { BillingKind, MessageFactsDto, PaymentDetailsDto, ShipmentDto } from '@maily/shared';
import { db } from '../db/client.js';
import { enrichments } from '../db/schema.js';
import { enricherByName } from './registry.js';
import type { IcsFacts } from './enrichers/ics.js';
import type { InvoiceFacts } from './enrichers/invoice.js';
import type { PackageShipment } from './enrichers/package.js';
import type { TravelReservation } from './enrichers/travel.js';

/** Everything the current enrichers extract about one message, typed. */
export interface MessageFacts {
  ics: IcsFacts | null;
  travel: TravelReservation[];
  invoice: InvoiceFacts | null;
  shipments: PackageShipment[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Per-enricher shape guards over the parsed `result` JSON. */
function readIcs(r: unknown): IcsFacts | null {
  return isObj(r) && Array.isArray(r.events) ? (r as unknown as IcsFacts) : null;
}
function readTravel(r: unknown): TravelReservation[] {
  return isObj(r) && Array.isArray(r.reservations) ? (r.reservations as TravelReservation[]) : [];
}
function readInvoice(r: unknown): InvoiceFacts | null {
  if (!isObj(r) || !isObj(r.invoice)) return null;
  const inv = r.invoice;
  const lists = [inv.kids, inv.ibans, inv.accounts, inv.documents].every(Array.isArray);
  const kind = inv.kind === 'invoice' || inv.kind === 'receipt';
  return lists && kind ? (inv as unknown as InvoiceFacts) : null;
}
function readShipments(r: unknown): PackageShipment[] {
  return isObj(r) && Array.isArray(r.shipments) ? (r.shipments as PackageShipment[]) : [];
}

/** The enrichers this module reads, by ledger name. */
const READERS = {
  ics: readIcs,
  travel: readTravel,
  invoice: readInvoice,
  package: readShipments,
} as const;

type Name = keyof typeof READERS;

function parse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The trusted, typed facts for one message (empty when nothing usable is stored). */
export function messageFacts(messageId: string): MessageFacts {
  const rows = db
    .select({
      enricher: enrichments.enricher,
      version: enrichments.enricherVersion,
      result: enrichments.result,
    })
    .from(enrichments)
    .where(
      and(
        eq(enrichments.messageId, messageId),
        eq(enrichments.status, 'ok'),
        inArray(enrichments.enricher, Object.keys(READERS)),
      ),
    )
    .all();

  const current = new Map<Name, unknown>();
  for (const row of rows) {
    const name = row.enricher as Name;
    if (enricherByName(name)?.version !== row.version) continue;
    current.set(name, parse(row.result));
  }
  return {
    ics: readIcs(current.get('ics')),
    travel: readTravel(current.get('travel')),
    invoice: readInvoice(current.get('invoice')),
    shipments: readShipments(current.get('package')),
  };
}

/**
 * True when an invoice (not a receipt — that's paid) carries a checksum-validated payment
 * identifier: a bill you can pay from the message. An amount or a due date alone doesn't
 * clear it.
 */
export function isPayable(invoice: InvoiceFacts | null): invoice is InvoiceFacts {
  return Boolean(
    invoice?.kind === 'invoice' &&
    (invoice.kids.length > 0 || invoice.accounts.length > 0 || invoice.ibans.length > 0),
  );
}

/**
 * SQL twins of the rules above, for search and the cleanup gate: `EXISTS` over the
 * trusted ledger row of one enricher (same status + current-version bar as
 * `messageFacts`). `alias` is the caller's messages-table alias. Keep each in step with
 * its JS counterpart — facts-read.test.ts pins both against the same rows.
 */
function currentRowSql(enricher: Name, condition: SQL, alias: string): SQL {
  const version = enricherByName(enricher)?.version ?? -1;
  return sql`EXISTS (SELECT 1 FROM enrichments e
    WHERE e.message_id = ${sql.raw(alias)}.id AND e.enricher = ${enricher}
      AND e.status = 'ok' AND e.enricher_version = ${version} AND ${condition})`;
}

/** A non-empty JSON array at `path` in the row's result (invalid JSON reads as empty). */
const nonEmpty = (path: string): SQL =>
  sql`CASE WHEN json_valid(e.result) THEN json_array_length(e.result, ${path}) END > 0`;

/** The row's billing kind is `kind` (invalid JSON reads as neither). */
const kindIs = (kind: BillingKind): SQL =>
  sql`CASE WHEN json_valid(e.result) THEN json_extract(e.result, '$.invoice.kind') END = ${kind}`;

/** SQL for `isPayable`: an invoice with a validated KID, account or IBAN. */
export function payableSql(alias = 'm'): SQL {
  const any = sql`(${kindIs('invoice')} AND (${nonEmpty('$.invoice.kids')}
    OR ${nonEmpty('$.invoice.accounts')} OR ${nonEmpty('$.invoice.ibans')}))`;
  return currentRowSql('invoice', any, alias);
}

/** Either kind — the shape `readInvoice` trusts (a kind-less row reads as no facts). */
const classified = (): SQL => sql`(${kindIs('invoice')} OR ${kindIs('receipt')})`;

/** SQL: the message is an invoice or a receipt — `kind` narrows it to one. */
export function billingSql(kind?: BillingKind, alias = 'm'): SQL {
  return currentRowSql('invoice', kind ? kindIs(kind) : classified(), alias);
}

/** SQL: the invoice carries a validated KID. */
export function hasKidSql(alias = 'm'): SQL {
  return currentRowSql('invoice', sql`(${classified()} AND ${nonEmpty('$.invoice.kids')})`, alias);
}

/** SQL: at least one parcel shipment was found. */
export function hasTrackingSql(alias = 'm'): SQL {
  return currentRowSql('package', nonEmpty('$.shipments'), alias);
}

/**
 * Only http(s) tracking links reach the client: JSON-LD `trackingUrl` is whatever the
 * sender wrote, and a `javascript:` URL behind a "Track" button is an injection.
 */
function safeUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/** The reader's view of a message's facts. */
export function toMessageFactsDto(facts: MessageFacts): MessageFactsDto {
  const inv = facts.invoice;
  const payment: PaymentDetailsDto | null = isPayable(inv)
    ? {
        kids: inv.kids,
        accounts: inv.accounts,
        ibans: inv.ibans,
        amount: inv.amount ? { value: inv.amount.value, currency: inv.amount.currency } : null,
        dueDate: inv.dueDate,
      }
    : null;
  const shipments: ShipmentDto[] = facts.shipments.map((s) => ({
    carrier: s.carrier,
    trackingNumber: s.trackingNumber,
    trackingUrl: safeUrl(s.trackingUrl),
    estimatedDelivery: s.estimatedDelivery,
  }));
  return {
    billing: inv?.kind ?? null,
    documents: inv?.documents ?? [],
    payment,
    shipments,
  };
}
