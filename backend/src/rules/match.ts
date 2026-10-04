/**
 * Pure rule matching and conflict resolution — no DB, so the precedence rules are pinned by
 * plain unit tests.
 *
 * Precedence: the move comes from the most specific matching rule that has one. Specificity:
 * a sender rule before a domain rule, a longer (deeper) domain before its parent, a rule
 * for this account before an every-account one, then the oldest rule. The read/star
 * flags are OR-ed across every matching rule.
 *
 * `protect` is not an ingest action (it gates cleanup, see cleanup/safety.ts), so a
 * protect-only rule never matches here — it neither acts on new mail nor counts a hit.
 */
import type { RuleMatchKind, RuleMove } from '@maily/shared';

export interface RuleLike {
  id: string;
  accountId: string | null;
  matchKind: RuleMatchKind;
  matchValue: string;
  move: RuleMove | null;
  markRead: boolean;
  star: boolean;
  createdAt: Date | null;
}

/** Whether a rule does anything to new mail (move / read / star). */
export function hasIngestAction(rule: Pick<RuleLike, 'move' | 'markRead' | 'star'>): boolean {
  return rule.move !== null || rule.markRead || rule.star;
}

export interface Resolution {
  move: RuleMove | null;
  markRead: boolean;
  star: boolean;
  /** Every rule that matched (all of them count a hit). */
  matched: string[];
}

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
const ADDRESS_RE = /^[^\s@]+@[^\s@]+$/;

/**
 * Canonical form of a match value, or null if it isn't one. A domain may be typed with a
 * leading `@` or `*.`; a sender is a bare address.
 */
export function normalizeMatchValue(kind: RuleMatchKind, raw: string): string | null {
  let v = raw.trim().toLowerCase();
  if (kind === 'sender') return ADDRESS_RE.test(v) ? v : null;
  v = v.replace(/^\*\./, '').replace(/^@/, '').replace(/\.$/, '');
  return DOMAIN_RE.test(v) ? v : null;
}

/** The domain part of an address, lowercased; null when there is none. */
export function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  return at < 0 || at === address.length - 1 ? null : address.slice(at + 1).toLowerCase();
}

/** Whether a rule matches a sender address. Domain rules also match subdomains. */
export function ruleMatches(rule: RuleLike, fromAddress: string | null): boolean {
  if (!fromAddress) return false;
  const from = fromAddress.trim().toLowerCase();
  if (rule.matchKind === 'sender') return from === rule.matchValue;
  const domain = domainOf(from);
  return domain !== null && (domain === rule.matchValue || domain.endsWith(`.${rule.matchValue}`));
}

/** Most specific first (see the module comment). */
export function bySpecificity(a: RuleLike, b: RuleLike): number {
  if (a.matchKind !== b.matchKind) return a.matchKind === 'sender' ? -1 : 1;
  if (a.matchValue.length !== b.matchValue.length) return b.matchValue.length - a.matchValue.length;
  if ((a.accountId === null) !== (b.accountId === null)) return a.accountId === null ? 1 : -1;
  return (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0);
}

/**
 * Combine the rules that match one message into a single set of actions. `rules` must
 * already be scoped to the message's account (or every account). Returns null when none match.
 */
export function resolveRules(rules: RuleLike[], fromAddress: string | null): Resolution | null {
  const hits = rules
    .filter((r) => hasIngestAction(r) && ruleMatches(r, fromAddress))
    .sort(bySpecificity);
  if (hits.length === 0) return null;
  return {
    move: hits.find((r) => r.move !== null)?.move ?? null,
    markRead: hits.some((r) => r.markRead),
    star: hits.some((r) => r.star),
    matched: hits.map((r) => r.id),
  };
}
