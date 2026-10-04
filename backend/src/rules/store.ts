/**
 * `mail_rules` persistence: CRUD for `/api/rules` plus the reads the apply path needs.
 * Input is validated and normalized here, so every row the matcher sees is canonical.
 */
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { MailRule, MailRuleInput, RuleMatchKind, RuleMove } from '@maily/shared';
import { db, withWriteRetry } from '../db/client.js';
import { accounts, mailRules } from '../db/schema.js';
import { normalizeMatchValue, type RuleLike } from './match.js';

type RuleRow = typeof mailRules.$inferSelect;

const MATCH_KINDS: readonly RuleMatchKind[] = ['sender', 'domain'];
const MOVES: readonly RuleMove[] = ['spam', 'archive', 'trash'];

export class RuleInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

export function toDto(r: RuleRow): MailRule {
  return {
    id: r.id,
    accountId: r.accountId,
    matchKind: r.matchKind,
    matchValue: r.matchValue,
    move: r.move,
    markRead: r.markRead,
    star: r.star,
    protect: r.protect,
    enabled: r.enabled,
    hits: r.hits,
    lastHitAt: r.lastHitAt?.getTime() ?? null,
    createdAt: r.createdAt?.getTime() ?? 0,
  };
}

export interface ValidRule {
  accountId: string | null;
  matchKind: RuleMatchKind;
  matchValue: string;
  move: RuleMove | null;
  markRead: boolean;
  star: boolean;
  protect: boolean;
  enabled: boolean;
}

/** Validate and normalize a request body. Throws RuleInputError with a user-facing reason. */
export function validateRuleInput(body: unknown): ValidRule {
  const b = (body ?? {}) as Partial<Record<keyof MailRuleInput, unknown>>;
  const matchKind = b.matchKind as RuleMatchKind;
  if (!MATCH_KINDS.includes(matchKind)) {
    throw new RuleInputError(`matchKind must be one of ${MATCH_KINDS.join(', ')}`);
  }
  const matchValue =
    typeof b.matchValue === 'string' ? normalizeMatchValue(matchKind, b.matchValue) : null;
  if (!matchValue) {
    throw new RuleInputError(
      matchKind === 'sender'
        ? 'matchValue must be an email address'
        : 'matchValue must be a domain',
    );
  }
  const move = (b.move ?? null) as RuleMove | null;
  if (move !== null && !MOVES.includes(move)) {
    throw new RuleInputError(`move must be one of ${MOVES.join(', ')} or null`);
  }
  for (const k of ['markRead', 'star', 'protect', 'enabled'] as const) {
    if (b[k] !== undefined && typeof b[k] !== 'boolean') {
      throw new RuleInputError(`${k} must be a boolean`);
    }
  }
  const markRead = (b.markRead as boolean | undefined) ?? false;
  const star = (b.star as boolean | undefined) ?? false;
  const protect = (b.protect as boolean | undefined) ?? false;
  if (move === null && !markRead && !star && !protect) {
    throw new RuleInputError('a rule needs at least one action (move, markRead, star or protect)');
  }
  // Protecting mail from cleanup while trashing it on arrival contradicts itself.
  if (protect && move === 'trash') {
    throw new RuleInputError('a protect rule cannot also move mail to Trash');
  }
  const accountId = (b.accountId ?? null) as string | null;
  if (accountId !== null) {
    const known =
      typeof accountId === 'string' &&
      db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).get();
    if (!known) throw new RuleInputError('unknown accountId');
  }
  return {
    accountId,
    matchKind,
    matchValue,
    move,
    markRead,
    star,
    protect,
    enabled: (b.enabled as boolean | undefined) ?? true,
  };
}

const DUPLICATE = 'a rule for this match already exists';

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

export function listRules(): MailRule[] {
  return db
    .select()
    .from(mailRules)
    .orderBy(mailRules.matchKind, mailRules.matchValue)
    .all()
    .map(toDto);
}

export function getRule(id: string): RuleRow | undefined {
  return db.select().from(mailRules).where(eq(mailRules.id, id)).get();
}

export function createRule(input: ValidRule): MailRule {
  try {
    const row = withWriteRetry('rules.create', () =>
      db
        .insert(mailRules)
        .values({ ...input, createdAt: new Date(), updatedAt: new Date() })
        .returning()
        .get(),
    );
    return toDto(row);
  } catch (err) {
    if (isUniqueViolation(err)) throw new RuleInputError(DUPLICATE, 409);
    throw err;
  }
}

/**
 * Replace a rule's match and actions. `createdAt` is kept: editing a rule doesn't reach back
 * to mail that arrived before the rule existed, and it doesn't reset the cut-off either.
 */
export function updateRule(id: string, input: ValidRule): MailRule {
  try {
    const row = withWriteRetry('rules.update', () =>
      db
        .update(mailRules)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(mailRules.id, id))
        .returning()
        .get(),
    );
    if (!row) throw new RuleInputError('rule not found', 404);
    return toDto(row);
  } catch (err) {
    if (isUniqueViolation(err)) throw new RuleInputError(DUPLICATE, 409);
    throw err;
  }
}

/** Toggle enabled without resending the whole rule. */
export function setRuleEnabled(id: string, enabled: boolean): MailRule | undefined {
  const row = withWriteRetry('rules.enable', () =>
    db
      .update(mailRules)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(mailRules.id, id))
      .returning()
      .get(),
  );
  return row ? toDto(row) : undefined;
}

export function deleteRule(id: string): boolean {
  return (
    withWriteRetry('rules.delete', () => db.delete(mailRules).where(eq(mailRules.id, id)).run())
      .changes === 1
  );
}

/** Enabled rules that apply to an account: its own plus the every-account ones. */
export function enabledRulesFor(accountId: string): RuleLike[] {
  return db
    .select()
    .from(mailRules)
    .where(
      and(
        eq(mailRules.enabled, true),
        or(eq(mailRules.accountId, accountId), isNull(mailRules.accountId)),
      ),
    )
    .all();
}

/** Add matches to each rule's count (transparency only — nothing reads this to decide). */
export function recordHits(counts: Map<string, number>, at: Date): void {
  withWriteRetry('rules.hits', () =>
    db.transaction(() => {
      for (const [id, n] of counts) {
        db.update(mailRules)
          .set({ hits: sql`${mailRules.hits} + ${n}`, lastHitAt: at })
          .where(eq(mailRules.id, id))
          .run();
      }
    }),
  );
}
