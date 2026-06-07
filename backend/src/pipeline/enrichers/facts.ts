/**
 * `facts` — the reference / smoke enricher (Phase 4 framework).
 *
 * Deliberately trivial: it exists to prove the pipeline loop end-to-end (queue →
 * run → persist → reindex) and to back the framework tests, NOT as a real product
 * feature. It is a `search`-kind enricher (no side effects) that extracts a few
 * deterministic facts from already-parsed columns — sender domain, whether the
 * message carries an HTML body, and the recipient count. Real deterministic
 * enrichers (JSON-LD travel, ICS, package, invoice) land in subsequent roadmap
 * bullets; this one is intentionally inert.
 */
import type { Enricher, EnricherContext, EnricherResult } from '../types.js';

export interface MessageFacts {
  /** Lowercased domain of the From address, or null when unparseable. */
  senderDomain: string | null;
  /** Whether an HTML body part was stored. */
  hasHtmlBody: boolean;
  /** Count of distinct To + Cc recipients. */
  recipientCount: number;
}

function domainOf(address: string | null): string | null {
  if (!address) return null;
  const at = address.lastIndexOf('@');
  if (at < 0 || at === address.length - 1) return null;
  return address.slice(at + 1).toLowerCase();
}

export const factsEnricher: Enricher = {
  name: 'facts',
  version: 1,
  kind: 'search',
  run(ctx: EnricherContext): EnricherResult {
    const { message } = ctx;
    const facts: MessageFacts = {
      senderDomain: domainOf(message.fromAddress),
      hasHtmlBody: Boolean(message.bodyHtml),
      recipientCount: message.to.length + message.cc.length,
    };
    return { result: facts };
  },
};
