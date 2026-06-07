/**
 * Proposal data access — the read/resolve side of the `derived` stage (ARCHITECTURE
 * §15). The runner (`runner.ts`) *writes* proposals as enrichers emit them; this module
 * is what the Action Center route reads and what approve/dismiss mutate.
 *
 * Two anti-"second inbox" guardrails from ROADMAP Phase 4 live here:
 *  - **Silent expiry** — `expireStaleProposals` lazily flips pending offers past their
 *    `expiresAt` horizon to `expired`, run before every list. No cron: an ignored offer
 *    ages out on the next read, never nags, never accumulates.
 *  - **Deleted-mail suppression** — offers on a tombstoned (`deletedAt`) message are
 *    hidden; if the user trashed the mail, its offer is moot.
 */
import { and, desc, eq, isNull, lte } from 'drizzle-orm';
import type { ProposalDto } from '@maily/shared';
import { db, withWriteRetry } from '../db/client.js';
import { messages, proposals } from '../db/schema.js';

type ProposalRow = typeof proposals.$inferSelect;

/** Parse a stored JSON payload, tolerating null/garbage (returns null on either). */
function parsePayload(json: string | null): unknown {
  if (json == null) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Shape a joined (proposal, message) row into the client DTO. */
function toDto(row: {
  p: ProposalRow;
  subject: string | null;
  fromName: string | null;
  fromAddress: string | null;
  receivedAt: Date | null;
}): ProposalDto {
  return {
    id: row.p.id,
    messageId: row.p.messageId,
    enricher: row.p.enricher,
    type: row.p.type,
    title: row.p.title,
    payload: parsePayload(row.p.payload),
    createdAt: iso(row.p.createdAt),
    expiresAt: iso(row.p.expiresAt),
    source: {
      subject: row.subject,
      fromName: row.fromName,
      fromAddress: row.fromAddress,
      receivedAt: iso(row.receivedAt),
    },
  };
}

/**
 * Lazily expire pending offers past their horizon. Self-healing (no scheduler): called
 * before every list/count so the user only ever sees live offers. Returns the count
 * expired (observability). Offers with a null `expiresAt` never expire.
 */
export function expireStaleProposals(now: Date = new Date()): number {
  return withWriteRetry('proposals.expireStale', () =>
    db
      .update(proposals)
      .set({ status: 'expired', resolvedAt: now })
      .where(and(eq(proposals.status, 'pending'), lte(proposals.expiresAt, now)))
      .run(),
  ).changes;
}

/** Base join select for the pending-proposal views (message context + tombstone filter). */
function selectPending() {
  return db
    .select({
      p: proposals,
      subject: messages.subject,
      fromName: messages.fromName,
      fromAddress: messages.fromAddress,
      receivedAt: messages.receivedAt,
    })
    .from(proposals)
    .innerJoin(messages, eq(proposals.messageId, messages.id));
}

/** All live (pending, non-expired, non-deleted-source) proposals, newest-first. */
export function listPendingProposals(now: Date = new Date()): ProposalDto[] {
  expireStaleProposals(now);
  return selectPending()
    .where(and(eq(proposals.status, 'pending'), isNull(messages.deletedAt)))
    .orderBy(desc(proposals.createdAt))
    .all()
    .map(toDto);
}

/** Live proposals for one message (drives the inline action chip in the reader). */
export function proposalsForMessage(messageId: string, now: Date = new Date()): ProposalDto[] {
  expireStaleProposals(now);
  return selectPending()
    .where(
      and(
        eq(proposals.messageId, messageId),
        eq(proposals.status, 'pending'),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(desc(proposals.createdAt))
    .all()
    .map(toDto);
}

/** Count of live proposals (drives the Action Center nav badge). */
export function pendingProposalCount(now: Date = new Date()): number {
  expireStaleProposals(now);
  return db
    .select({ id: proposals.id })
    .from(proposals)
    .innerJoin(messages, eq(proposals.messageId, messages.id))
    .where(and(eq(proposals.status, 'pending'), isNull(messages.deletedAt)))
    .all().length;
}

/** Fetch one proposal row by id (null if gone). */
export function getProposal(id: string): ProposalRow | undefined {
  return db.select().from(proposals).where(eq(proposals.id, id)).get();
}

/**
 * Resolve a proposal to a terminal state (approve/dismiss). Idempotent + race-safe:
 * the `status='pending'` guard means a double-click resolves once; the second is a
 * no-op (`changes === 0`). Returns whether this call performed the transition.
 */
function resolve(id: string, status: 'approved' | 'dismissed', now: Date): boolean {
  return (
    withWriteRetry('proposals.resolve', () =>
      db
        .update(proposals)
        .set({ status, resolvedAt: now })
        .where(and(eq(proposals.id, id), eq(proposals.status, 'pending')))
        .run(),
    ).changes > 0
  );
}

export function approveProposal(id: string, now: Date = new Date()): boolean {
  return resolve(id, 'approved', now);
}

export function dismissProposal(id: string, now: Date = new Date()): boolean {
  return resolve(id, 'dismissed', now);
}
