/**
 * Enrichment-pipeline contracts (ROADMAP Phase 4; ARCHITECTURE §14/§15).
 *
 * An *enricher* is a pure-ish function over a parsed message that produces a
 * `result` (search tokens / extracted facts to persist on the `enriched` stage)
 * and/or `proposals` (the `derived` stage — offers surfaced later by the Action
 * Center). Every enricher declares a `kind` (its classification) and a `version`;
 * the framework handles queuing, tiering, retries, dead-lettering, persistence and
 * reindex around it. Enrichers themselves stay small and side-effect-light — the
 * one exception being `operational` enrichers, which the *framework* gates by tier
 * so a deep backfill can't fire stale side effects.
 */
import type { EmailAddress } from '@maily/shared';

/**
 * Enrichment classification (ARCHITECTURE §14). Drives tiering + ordering:
 *  - `operational` — has external side effects (Action Center / CalDAV / tasks);
 *    runs only on Tier-0 (recent) mail so a backfill never fires stale actions.
 *  - `search`      — tags / entities / keywords that feed the search index.
 *  - `analytical`  — summaries / scoring.
 * `search` + `analytical` run on ALL tiers (old mail stays fully searchable).
 */
export type EnrichmentKind = 'operational' | 'search' | 'analytical';

/**
 * Scheduling cost of an enricher (ROADMAP Phase 5, the N150 guard). Orthogonal to
 * `kind` (which gates *side effects* by age): `cost` gates *throughput* by expense.
 *  - `cheap` — deterministic, sub-millisecond CPU (the Phase-4 enrichers). Drained to
 *    completion every nudge.
 *  - `llm`   — an Ollama generation: seconds of CPU, serialised single-flight. Drained
 *    a small bounded batch per nudge so a deep backlog can never starve the cheap
 *    pipeline or monopolise the worker against mail sync.
 * Stored per row so the claim scan can filter by cost in SQL (no starvation: cheap mail
 * is always claimable independent of however large the LLM backlog is).
 */
export type EnrichmentCost = 'cheap' | 'llm';

/** Age-tier of a message (ARCHITECTURE §14). 0 = recent (≤ horizon), 1 = older. */
export type Tier = 0 | 1 | 2;

/**
 * The parsed-stage view an enricher reads — derived columns only (a pure function
 * of the canonical `.eml`, §15). Mailbox-state (flags/folders) is deliberately absent;
 * enrichment is about content, not mailbox state.
 */
export interface PipelineMessage {
  id: string;
  accountId: string;
  threadId: string | null;
  subject: string | null;
  fromName: string | null;
  fromAddress: string | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  snippet: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  /** Captured iCalendar (text/calendar) part for a calendar invite; null when absent. */
  bodyCalendar: string | null;
  inReplyTo: string | null;
  references: string | null;
  sentAt: Date | null;
  receivedAt: Date | null;
  /** On-disk raw `.eml` path, when archived (lets enrichers reach the full source). */
  sourcePath: string | null;
}

/** A proposal an enricher wants to surface against its source message. */
export interface ProposalDraft {
  /** Proposal kind, e.g. 'calendar_event' | 'package_track' (enricher-defined). */
  type: string;
  /** Human-readable label for the action chip / list row. */
  title?: string;
  /** JSON-serialisable detail the approve-flow will act on. */
  payload?: unknown;
  /**
   * When the offer silently expires (anti-"second inbox"). Omit to use the
   * framework default (horizon-bounded); pass null for no expiry.
   */
  expiresAt?: Date | null;
}

/** What an enricher returns: a persisted result and/or proposals. Both optional. */
export interface EnricherResult {
  /** JSON-serialisable output persisted to `enrichments.result` (search tokens, facts). */
  result?: unknown;
  /** Offers to persist to `proposals` (replaces this enricher's prior proposals). */
  proposals?: ProposalDraft[];
}

/** Context handed to an enricher run. */
export interface EnricherContext {
  message: PipelineMessage;
  tier: Tier;
}

/** A registered enricher. */
export interface Enricher {
  /** Stable name (the ledger key; paired with `version`). */
  name: string;
  /** Bump to mark all prior rows stale + eligible for re-run (drives reindex). */
  version: number;
  kind: EnrichmentKind;
  /** Scheduling cost (default `cheap`). `llm` enrichers are drained in bounded batches. */
  cost?: EnrichmentCost;
  /**
   * Optional gate: return false to skip this message entirely. Evaluated at RUN time
   * (with the full message) — a skipped run is recorded as a no-op success so it is
   * not retried. Keeping the gate here (not at enqueue) keeps ingest cheap.
   */
  applies?(message: PipelineMessage): boolean;
  run(ctx: EnricherContext): EnricherResult | Promise<EnricherResult>;
}
