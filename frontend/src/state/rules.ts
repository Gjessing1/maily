/**
 * Client helpers for mail rules (`/api/rules`): the reader's one-tap "Block sender/domain",
 * cleanup's one-tap "Protect sender", the bounded apply-to-existing loop, and the labels the
 * rule list and editor share.
 */
import type { MailRule, MailRuleInput, RuleMatchKind, RuleMove } from '@maily/shared';
import { api, ApiError } from '../api/client';

/** Most apply passes one save runs (each pass is bounded server-side). */
const MAX_APPLY_PASSES = 50;

/** The server's `{ "error": "…" }` reason, or the raw message when the body isn't one. */
export function ruleErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(message) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    /* not JSON */
  }
  return message;
}

const MOVE_LABEL: Record<RuleMove, string> = {
  spam: 'Move to Spam',
  archive: 'Archive',
  trash: 'Move to Trash',
};

/** "Move to Spam · Mark read · Star · Protect from cleanup" — what a rule does, in list-row form. */
export function describeActions(
  rule: Pick<MailRule, 'move' | 'markRead' | 'star'> & { protect?: boolean },
): string {
  const parts: string[] = [];
  if (rule.move) parts.push(MOVE_LABEL[rule.move]);
  if (rule.markRead) parts.push('Mark read');
  if (rule.star) parts.push('Star');
  if (rule.protect) parts.push('Protect from cleanup');
  return parts.join(' · ');
}

/**
 * Domains shared by unrelated people. Blocking one would send everyone on that provider to
 * Spam, so the reader only offers "Block sender" for them.
 */
const SHARED_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.no',
  'live.com',
  'live.no',
  'msn.com',
  'yahoo.com',
  'yahoo.no',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'mailbox.org',
  'gmx.com',
  'gmx.net',
  'gmx.de',
  'web.de',
  'online.no',
  'fastmail.com',
  'zoho.com',
  'yandex.com',
  'tutanota.com',
]);

export function isSharedMailDomain(domain: string): boolean {
  return SHARED_MAIL_DOMAINS.has(domain.toLowerCase());
}

/**
 * Create an every-account rule for a match with `actions`, or — when one already exists — merge
 * `actions` into it (and switch it back on) rather than duplicating it, keeping its other actions.
 */
async function upsertEveryAccountRule(
  kind: RuleMatchKind,
  value: string,
  actions: Pick<MailRuleInput, 'move' | 'protect'>,
): Promise<MailRule> {
  const matchValue = value.trim().toLowerCase();
  try {
    return await api.rules.create({ matchKind: kind, matchValue, ...actions });
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 409) throw err;
    const existing = (await api.rules.list()).find(
      (r) => r.accountId === null && r.matchKind === kind && r.matchValue === matchValue,
    );
    if (!existing) throw err;
    return api.rules.update(existing.id, { ...toInput(existing), ...actions, enabled: true });
  }
}

/** Make future mail from a sender or domain land in Spam, on every account. */
export function blockSender(kind: RuleMatchKind, value: string): Promise<MailRule> {
  return upsertEveryAccountRule(kind, value, { move: 'spam' });
}

/**
 * Shield all mail from a cleanup sender group from cleanup, on every account. A group key with
 * an `@` is one freemail address; anything else is a domain (its subdomains included).
 */
export function protectSender(senderKey: string): Promise<MailRule> {
  return upsertEveryAccountRule(senderKey.includes('@') ? 'sender' : 'domain', senderKey, {
    protect: true,
  });
}

/** A saved rule as a create/replace body. */
export function toInput(rule: MailRule): MailRuleInput {
  return {
    accountId: rule.accountId,
    matchKind: rule.matchKind,
    matchValue: rule.matchValue,
    move: rule.move,
    markRead: rule.markRead,
    star: rule.star,
    protect: rule.protect,
    enabled: rule.enabled,
  };
}

/**
 * Run a saved rule over the INBOX mail it already matches, pass by pass, until none is left.
 * Stops early if a pass changes nothing (the leftovers don't really match). Returns the total
 * changed.
 */
export async function applyRuleToExisting(id: string): Promise<number> {
  let total = 0;
  for (let pass = 0; pass < MAX_APPLY_PASSES; pass++) {
    const { applied, remaining } = await api.rules.apply(id);
    total += applied;
    if (remaining === 0 || applied === 0) break;
  }
  return total;
}
