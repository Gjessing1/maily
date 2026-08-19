/**
 * The reader's add-sender offer is only anti-chore if it stays quiet for machine mail —
 * most unknown senders in a real mailbox are automated, and prompting on those is exactly
 * the backlog §A2 rules out. These pin both directions: a machine address is never
 * offered, and an ordinary person always is (a missed prompt is a silently lost feature).
 */
import { describe, expect, it } from 'vitest';
import { isPromptableSender } from './senderPrompt';

describe('isPromptableSender', () => {
  it('offers ordinary personal and role addresses', () => {
    for (const addr of [
      'alice@example.com',
      'Alice.Smith@Example.co.uk',
      'a.b+tag@example.org',
      'support@example.com',
      'post@firma.no',
    ]) {
      expect(isPromptableSender(addr), addr).toBe(true);
    }
  });

  it('stays silent for addresses that name themselves automated', () => {
    for (const addr of [
      'no-reply@example.com',
      'noreply@example.com',
      'No.Reply@Example.com',
      'do-not-reply@example.com',
      'donotreply@bank.example',
      'noreply-a83f21@notifications.example.com',
      'bounces+1234@mail.example.com',
      'MAILER-DAEMON@example.com',
      'postmaster@example.com',
      'newsletter@shop.example',
      'unsubscribe@shop.example',
    ]) {
      expect(isPromptableSender(addr), addr).toBe(false);
    }
  });

  it('stays silent for anything that is not a filable address', () => {
    expect(isPromptableSender(null)).toBe(false);
    expect(isPromptableSender(undefined)).toBe(false);
    expect(isPromptableSender('   ')).toBe(false);
    expect(isPromptableSender('not-an-address')).toBe(false);
    expect(isPromptableSender('@example.com')).toBe(false);
    expect(isPromptableSender('alice@')).toBe(false);
    expect(isPromptableSender('alice@localhost')).toBe(false);
  });
});
