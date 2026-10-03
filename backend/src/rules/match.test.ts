/**
 * Pure matcher + precedence. Pins the rule-center contract: a domain rule covers its
 * subdomains, a sender rule's move beats a domain rule's, and read/star are OR-ed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMatchValue, resolveRules, ruleMatches, type RuleLike } from './match.js';

let seq = 0;
function rule(p: Partial<RuleLike> & Pick<RuleLike, 'matchKind' | 'matchValue'>): RuleLike {
  seq += 1;
  return {
    id: `r${seq}`,
    accountId: null,
    move: null,
    markRead: false,
    star: false,
    createdAt: new Date(1_000 + seq),
    ...p,
  };
}

test('normalizeMatchValue: canonical senders and domains, junk rejected', () => {
  assert.equal(normalizeMatchValue('sender', '  News@Shop.Example '), 'news@shop.example');
  assert.equal(normalizeMatchValue('sender', 'no-at-sign'), null);
  assert.equal(normalizeMatchValue('domain', '@Shop.Example'), 'shop.example');
  assert.equal(normalizeMatchValue('domain', '*.shop.example.'), 'shop.example');
  assert.equal(normalizeMatchValue('domain', 'a@shop.example'), null);
  assert.equal(normalizeMatchValue('domain', 'localhost'), null);
  assert.equal(normalizeMatchValue('domain', '%.example'), null, 'no LIKE wildcards');
});

test('ruleMatches: sender is exact, domain also matches subdomains but not lookalikes', () => {
  const sender = rule({ matchKind: 'sender', matchValue: 'a@shop.example' });
  assert.ok(ruleMatches(sender, 'A@Shop.Example'));
  assert.ok(!ruleMatches(sender, 'b@shop.example'));
  assert.ok(!ruleMatches(sender, null));

  const domain = rule({ matchKind: 'domain', matchValue: 'shop.example' });
  assert.ok(ruleMatches(domain, 'x@shop.example'));
  assert.ok(ruleMatches(domain, 'x@mail.shop.example'));
  assert.ok(!ruleMatches(domain, 'x@badshop.example'));
  assert.ok(!ruleMatches(domain, 'shop.example@other.example'));
});

test('a sender rule decides the move over a domain rule, whatever the order', () => {
  const domain = rule({ matchKind: 'domain', matchValue: 'shop.example', move: 'spam' });
  const sender = rule({
    matchKind: 'sender',
    matchValue: 'receipts@shop.example',
    move: 'archive',
  });
  for (const rules of [
    [domain, sender],
    [sender, domain],
  ]) {
    const r = resolveRules(rules, 'receipts@shop.example')!;
    assert.equal(r.move, 'archive');
    assert.deepEqual(new Set(r.matched), new Set([domain.id, sender.id]));
  }
  // Another sender at the domain still gets the domain rule.
  assert.equal(resolveRules([domain, sender], 'promo@shop.example')!.move, 'spam');
});

test('a sender rule without a move leaves the domain rule move in place', () => {
  const domain = rule({ matchKind: 'domain', matchValue: 'shop.example', move: 'trash' });
  const sender = rule({ matchKind: 'sender', matchValue: 'a@shop.example', star: true });
  const r = resolveRules([sender, domain], 'a@shop.example')!;
  assert.equal(r.move, 'trash');
  assert.equal(r.star, true);
});

test('deeper domain beats its parent; an account rule beats an every-account rule', () => {
  const parent = rule({ matchKind: 'domain', matchValue: 'shop.example', move: 'spam' });
  const child = rule({ matchKind: 'domain', matchValue: 'news.shop.example', move: 'archive' });
  assert.equal(resolveRules([parent, child], 'a@news.shop.example')!.move, 'archive');

  const global = rule({ matchKind: 'sender', matchValue: 'a@x.example', move: 'spam' });
  const scoped = rule({
    matchKind: 'sender',
    matchValue: 'a@x.example',
    accountId: 'acc',
    move: 'trash',
  });
  assert.equal(resolveRules([global, scoped], 'a@x.example')!.move, 'trash');
});

test('read and star are OR-ed across every matching rule; no match is null', () => {
  const a = rule({ matchKind: 'domain', matchValue: 'x.example', markRead: true });
  const b = rule({ matchKind: 'sender', matchValue: 'a@x.example', star: true });
  const r = resolveRules([a, b], 'a@x.example')!;
  assert.deepEqual([r.move, r.markRead, r.star], [null, true, true]);
  assert.equal(resolveRules([a, b], 'a@y.example'), null);
});
