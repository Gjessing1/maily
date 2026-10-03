/**
 * Blocking a sender never duplicates a rule, and apply-to-existing walks the bounded server
 * passes until nothing is left — without spinning when a pass changes nothing.
 */
import { beforeEach, expect, test, vi } from 'vitest';
import type { MailRule } from '@maily/shared';

const api = vi.hoisted(() => ({
  rules: { create: vi.fn(), list: vi.fn(), update: vi.fn(), apply: vi.fn() },
}));
vi.mock('../api/client', () => ({
  api,
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

const { ApiError } = await import('../api/client');
const { applyRuleToExisting, blockSender, describeActions, ruleErrorMessage } =
  await import('./rules');

const rule = (over: Partial<MailRule> = {}): MailRule => ({
  id: 'r1',
  accountId: null,
  matchKind: 'sender',
  matchValue: 'spam@example.com',
  move: null,
  markRead: true,
  star: false,
  enabled: false,
  hits: 3,
  lastHitAt: null,
  createdAt: 1,
  ...over,
});

beforeEach(() => {
  for (const fn of Object.values(api.rules)) fn.mockReset();
});

test('blocking creates an every-account spam rule for the lowercased address', async () => {
  api.rules.create.mockResolvedValue(rule({ move: 'spam' }));
  await blockSender('sender', ' Spam@Example.com ');
  expect(api.rules.create).toHaveBeenCalledWith({
    matchKind: 'sender',
    matchValue: 'spam@example.com',
    move: 'spam',
  });
});

test('blocking a sender that already has a rule turns that rule into an enabled spam rule', async () => {
  api.rules.create.mockRejectedValue(new ApiError(409, '{"error":"duplicate"}'));
  api.rules.list.mockResolvedValue([rule({ accountId: 'acc' }), rule()]);
  api.rules.update.mockResolvedValue(rule({ move: 'spam', enabled: true }));

  await blockSender('sender', 'spam@example.com');

  expect(api.rules.update).toHaveBeenCalledWith('r1', {
    accountId: null,
    matchKind: 'sender',
    matchValue: 'spam@example.com',
    move: 'spam',
    markRead: true,
    star: false,
    enabled: true,
  });
});

test('any other refusal is passed on', async () => {
  api.rules.create.mockRejectedValue(new ApiError(400, '{"error":"bad"}'));
  await expect(blockSender('domain', 'example.com')).rejects.toThrow('bad');
  expect(api.rules.list).not.toHaveBeenCalled();
});

test('apply-to-existing repeats bounded passes until none remain', async () => {
  api.rules.apply
    .mockResolvedValueOnce({ applied: 200, remaining: 50 })
    .mockResolvedValueOnce({ applied: 50, remaining: 0 });
  expect(await applyRuleToExisting('r1')).toBe(250);
  expect(api.rules.apply).toHaveBeenCalledTimes(2);
});

test('apply-to-existing stops when a pass changes nothing', async () => {
  api.rules.apply.mockResolvedValue({ applied: 0, remaining: 4 });
  expect(await applyRuleToExisting('r1')).toBe(0);
  expect(api.rules.apply).toHaveBeenCalledTimes(1);
});

test('labels', () => {
  expect(describeActions({ move: 'spam', markRead: true, star: true })).toBe(
    'Move to Spam · Mark read · Star',
  );
  expect(ruleErrorMessage(new Error('{"error":"a rule for this match already exists"}'))).toBe(
    'a rule for this match already exists',
  );
  expect(ruleErrorMessage(new Error('network error'))).toBe('network error');
});
