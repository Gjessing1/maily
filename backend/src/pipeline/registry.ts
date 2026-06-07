/**
 * Enricher registry. Holds the set of enrichers the pipeline runs and applies the
 * tier-based operational-suppression rule (ARCHITECTURE §14). The shared worker and
 * the enqueue path both read from here, so registration must happen at import time —
 * the default enrichers self-register below.
 *
 * `registerEnricher` / `unregisterEnricher` are also the seam tests use to add a
 * throwing enricher (failure/dead-letter path) without touching the defaults.
 */
import type { Enricher, Tier } from './types.js';
import { llmEnabled } from '../llm/index.js';
import { factsEnricher } from './enrichers/facts.js';
import { travelEnricher } from './enrichers/travel.js';
import { icsEnricher } from './enrichers/ics.js';
import { packageEnricher } from './enrichers/package.js';
import { invoiceEnricher } from './enrichers/invoice.js';
import { summaryEnricher } from './enrichers/summary.js';

const registry = new Map<string, Enricher>();

/** Register (or replace) an enricher by name. */
export function registerEnricher(enricher: Enricher): void {
  registry.set(enricher.name, enricher);
}

/** Remove an enricher (test cleanup / hot-swap). */
export function unregisterEnricher(name: string): void {
  registry.delete(name);
}

/** All registered enrichers. */
export function allEnrichers(): Enricher[] {
  return [...registry.values()];
}

/** Look up one enricher by name (null if not registered). */
export function enricherByName(name: string): Enricher | undefined {
  return registry.get(name);
}

/**
 * Enrichers eligible to be enqueued for a message at `tier`:
 *  - Tier 0 (recent): all.
 *  - Tier 1+ (older): search + analytical only — operational side effects suppressed.
 */
export function enrichersForTier(tier: Tier): Enricher[] {
  return allEnrichers().filter((e) => tier === 0 || e.kind !== 'operational');
}

// --- Default enrichers ------------------------------------------------------------------
// `facts` is the framework reference enricher (search-kind, inert). `travel` is the
// first real deterministic enricher: JSON-LD reservation extraction → calendar offers.
// `ics` parses the text/calendar invite part (VEVENT) → calendar offers (operational,
// Tier-0; shares the VEVENT-shaped draft with `travel`). `package` is search-kind
// shipment tracking (passive: feeds the index, no proposals). `invoice` is search-kind
// invoice/receipt extraction (KID/IBAN/account/amount/due date, checksum-validated;
// passive: feeds the index, no proposals).
registerEnricher(factsEnricher);
registerEnricher(travelEnricher);
registerEnricher(icsEnricher);
registerEnricher(packageEnricher);
registerEnricher(invoiceEnricher);

// `summary` is the first LLM enricher (Phase 5) — registered ONLY when Ollama is
// configured (`OLLAMA_URL`). Without it no `summary` rows are ever enqueued and the
// pipeline runs exactly as in Phase 4 (privacy-first: no cloud fallback).
if (llmEnabled()) registerEnricher(summaryEnricher);
