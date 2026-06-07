/**
 * Enrichment pipeline — public surface (ROADMAP Phase 4; ARCHITECTURE §14/§15).
 *
 * The framework: `ingest → enrich → index → actions`. A unit of work is a pending
 * row in the SQLite `enrichments` ledger (pull/claim queue → restart-safe,
 * reindex-native). `enqueueMessage` (ingest hook) creates the work; the shared
 * worker calls `drainPipeline` to run it. Enrichers register in `registry`.
 *
 * Importing this module registers the default enrichers (via `./registry`).
 */
export { enqueueMessage, backfillPending } from './enqueue.js';
export { drainPipeline, reindex, queueDepth, backoffMs } from './runner.js';
export type { DrainResult, DrainOptions, ProposalReady, ReindexScope } from './runner.js';
export {
  registerEnricher,
  unregisterEnricher,
  allEnrichers,
  enricherByName,
  enrichersForTier,
} from './registry.js';
export { tierForMessage } from './tiers.js';
export type {
  Enricher,
  EnricherContext,
  EnricherResult,
  EnrichmentKind,
  PipelineMessage,
  ProposalDraft,
  Tier,
} from './types.js';
