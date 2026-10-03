/**
 * Rule execution. Every effect goes through the outbox intents the user's own clicks use
 * (delete / archive / move / flags), so a rule's change is applied locally at once, retried
 * against the provider, and taken back if the provider never accepts it. Rule intents are due
 * immediately: there's no undo toast for a rule, since nobody clicked anything.
 *
 * Two entry points:
 * - {@link applyRulesOnIngest} — the INBOX sync's insert hook. Only rules created at or before
 *   the message's arrival apply, so creating a rule never reaches back into old mail.
 * - {@link applyRuleToExisting} — the explicit "apply to existing inbox mail", previewed first
 *   by {@link previewRule} and bounded per call.
 */
import { and, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import type { RulePreview, RuleApplyResult } from '@maily/shared';
import { db } from '../db/client.js';
import { folders, messageFolders, messages } from '../db/schema.js';
import { folderByRole } from '../db/queries.js';
import { visible } from '../db/visibility.js';
import {
  enqueueArchive,
  enqueueDelete,
  enqueueFlags,
  enqueueMove,
  nudgeOutbox,
} from '../outbox/runner.js';
import type { FlagSet } from '../outbox/intents.js';
import { createLogger } from '../logger.js';
import { resolveRules, type Resolution } from './match.js';
import { enabledRulesFor, getRule, recordHits, type ValidRule } from './store.js';

const log = createLogger('rules');

/** Most messages one apply-to-existing call touches. */
export const APPLY_BATCH = 200;
const PREVIEW_SAMPLE = 5;

/** What a rule did to a new message — what the sync engine needs to decide on `mail:new`. */
export interface IngestOutcome {
  /** Left the inbox (spam / archive / trash). */
  moved: boolean;
  /** Marked read. */
  read: boolean;
}

interface Target {
  id: string;
  accountId: string;
  seen: boolean;
  flagged: boolean;
}

/**
 * Carry out a resolution on one inbox message. Flags go first so their STORE is queued while the
 * message still sits in the inbox. Returns whether it left the inbox (false when the account
 * has no folder for that move).
 */
function execute(m: Target, inboxId: string, r: Resolution): boolean {
  const set: FlagSet = {};
  if (r.markRead && !m.seen) set.seen = true;
  if (r.star && !m.flagged) set.flagged = true;
  if (Object.keys(set).length > 0) enqueueFlags(m.accountId, m.id, set);

  const now = Date.now();
  switch (r.move) {
    case 'trash':
      enqueueDelete(m.accountId, m.id, now);
      return true;
    case 'archive': {
      const archive = folderByRole(m.accountId, 'archive');
      if (!archive) return false;
      enqueueArchive(m.accountId, m.id, archive.id, now);
      return true;
    }
    case 'spam': {
      const junk = folderByRole(m.accountId, 'junk');
      if (!junk) return false;
      enqueueMove(m.accountId, m.id, inboxId, { id: junk.id, role: 'junk' }, now);
      return true;
    }
    default:
      return false;
  }
}

/**
 * Apply the account's rules to a message the INBOX sync just inserted. Returns null when no rule
 * acted on it. Never throws: a broken rule must not stall the sync, so the failure is logged and
 * the message is left as delivered.
 */
export function applyRulesOnIngest(
  accountId: string,
  messageId: string,
  inboxId: string,
): IngestOutcome | null {
  try {
    const m = db
      .select({
        id: messages.id,
        accountId: messages.accountId,
        fromAddress: messages.fromAddress,
        receivedAt: messages.receivedAt,
        seen: messages.seen,
        flagged: messages.flagged,
      })
      .from(messages)
      .where(eq(messages.id, messageId))
      .get();
    if (!m) return null;
    // Without an INTERNALDATE the message is being delivered now, as far as we can tell.
    const arrived = m.receivedAt?.getTime() ?? Date.now();
    const rules = enabledRulesFor(accountId).filter(
      (r) => (r.createdAt?.getTime() ?? Infinity) <= arrived,
    );
    if (rules.length === 0) return null;
    const res = resolveRules(rules, m.fromAddress);
    if (!res) return null;

    const moved = execute(m, inboxId, res);
    recordHits(new Map(res.matched.map((id) => [id, 1])), new Date());
    nudgeOutbox();
    return { moved, read: res.markRead };
  } catch (err) {
    log.warn(`rules on ${messageId} failed: ${(err as Error).message}`);
    return null;
  }
}

// ── preview / apply to existing ─────────────────────────────────────────────

/**
 * SQL prefilter for a match over `messages.from_address`. The value is canonical (store.ts
 * validates domains to [a-z0-9.-]), so it carries no LIKE wildcards. Callers re-check each row
 * with the JS matcher, which stays the single definition of a match.
 */
function matchSql(rule: Pick<ValidRule, 'matchKind' | 'matchValue'>): SQL {
  const from = sql`lower(${messages.fromAddress})`;
  return rule.matchKind === 'sender'
    ? sql`${from} = ${rule.matchValue}`
    : sql`(${from} LIKE ${'%@' + rule.matchValue} OR ${from} LIKE ${'%.' + rule.matchValue})`;
}

/** Visible INBOX mail a rule matches that it would still change. */
function candidates(rule: Omit<ValidRule, 'enabled'>, limit: number) {
  const changes: SQL[] = [];
  if (rule.move) changes.push(sql`1`);
  if (rule.markRead) changes.push(sql`${messages.seen} = 0`);
  if (rule.star) changes.push(sql`${messages.flagged} = 0`);
  const where = and(
    eq(folders.role, 'inbox'),
    visible(),
    rule.accountId ? eq(messages.accountId, rule.accountId) : undefined,
    matchSql(rule),
    or(...changes),
  );
  const rows = db
    .select({
      id: messages.id,
      accountId: messages.accountId,
      inboxId: folders.id,
      fromAddress: messages.fromAddress,
      subject: messages.subject,
      receivedAt: messages.receivedAt,
      seen: messages.seen,
      flagged: messages.flagged,
    })
    .from(messageFolders)
    .innerJoin(folders, eq(folders.id, messageFolders.folderId))
    .innerJoin(messages, eq(messages.id, messageFolders.messageId))
    .where(where)
    .orderBy(desc(messages.receivedAt))
    .limit(limit)
    .all();
  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(messageFolders)
      .innerJoin(folders, eq(folders.id, messageFolders.folderId))
      .innerJoin(messages, eq(messages.id, messageFolders.messageId))
      .where(where)
      .get()?.n ?? 0;
  return { rows, total };
}

/** How much existing INBOX mail a (possibly unsaved) rule would change, with a few examples. */
export function previewRule(rule: Omit<ValidRule, 'enabled'>): RulePreview {
  const { rows, total } = candidates(rule, PREVIEW_SAMPLE);
  return {
    count: total,
    sample: rows.map((r) => ({
      id: r.id,
      fromAddress: r.fromAddress,
      subject: r.subject,
      receivedAt: r.receivedAt?.getTime() ?? 0,
    })),
  };
}

/**
 * Apply a saved, enabled rule to the INBOX mail it matches, newest first, at most
 * {@link APPLY_BATCH} messages a call. Each message gets the full resolution of every enabled
 * rule that matches it, so a sender rule still beats this domain rule here. Returns undefined
 * for an unknown rule and null for a disabled one.
 */
export function applyRuleToExisting(ruleId: string): RuleApplyResult | null | undefined {
  const rule = getRule(ruleId);
  if (!rule) return undefined;
  if (!rule.enabled) return null;

  const { rows, total } = candidates(rule, APPLY_BATCH);
  const rulesByAccount = new Map<string, ReturnType<typeof enabledRulesFor>>();
  const hits = new Map<string, number>();
  let applied = 0;
  for (const m of rows) {
    let rules = rulesByAccount.get(m.accountId);
    if (!rules) rulesByAccount.set(m.accountId, (rules = enabledRulesFor(m.accountId)));
    const res = resolveRules(rules, m.fromAddress);
    if (!res?.matched.includes(rule.id)) continue; // the SQL prefilter is looser than the matcher
    execute(m, m.inboxId, res);
    for (const id of res.matched) hits.set(id, (hits.get(id) ?? 0) + 1);
    applied += 1;
  }
  recordHits(hits, new Date());
  nudgeOutbox();
  return { applied, remaining: Math.max(0, total - applied) };
}
