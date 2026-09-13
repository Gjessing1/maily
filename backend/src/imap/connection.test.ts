/**
 * `createClient` shims an imapflow gap: `untaggedExpunge` decrements the cached
 * `mailbox.exists` but QRESYNC's `untaggedVanished` does not, and `untaggedExists`
 * drops any EXISTS equal to that cached count. These drive imapflow's real
 * untagged-response handlers (no socket), so an upgrade that changes either side
 * shows up here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ImapFlow, MailboxObject } from 'imapflow';
import type { AccountConfig } from '../config/accounts.js';
import { createClient } from './connection.js';

/** imapflow's untagged-response handlers — runtime methods the typings don't expose. */
interface UntaggedHandlers {
  untaggedExists(untagged: { command: string }): Promise<void>;
  untaggedExpunge(untagged: { command: string }): Promise<void>;
  untaggedVanished(untagged: { attributes: unknown[] }): Promise<void>;
}

const config = {
  imap: { host: 'imap.example.com', port: 993, secure: true, user: 'u', pass: 'p' },
} as AccountConfig;

/** A never-connected client whose INBOX is "selected" with `exists` messages. */
function selectedInbox(exists: number): { client: ImapFlow; imap: UntaggedHandlers } {
  const client = createClient(config);
  client.mailbox = { path: 'INBOX', exists } as MailboxObject;
  return { client, imap: client as unknown as UntaggedHandlers };
}

function cachedExists(client: ImapFlow): number {
  assert.ok(client.mailbox, 'mailbox selected');
  return client.mailbox.exists;
}

test('a live VANISHED lowers the cached count, so delete-then-deliver still fires `exists`', async () => {
  const { client, imap } = selectedInbox(66);
  const counts: number[] = [];
  client.on('exists', (event: { count: number }) => counts.push(event.count));

  await imap.untaggedVanished({ attributes: [{ type: 'SEQUENCE', value: '183' }] });
  assert.equal(cachedExists(client), 65);

  // The next delivery brings the mailbox back to 66 — the count imapflow had cached.
  await imap.untaggedExists({ command: '66' });
  assert.deepEqual(counts, [66], 'the delivery surfaced as an `exists` event');
});

test('VANISHED (EARLIER) leaves the cached count alone', async () => {
  const { client, imap } = selectedInbox(66);
  await imap.untaggedVanished({
    attributes: [[{ type: 'ATOM', value: 'EARLIER' }], { type: 'SEQUENCE', value: '181:183' }],
  });
  assert.equal(cachedExists(client), 66);
});

test('a plain EXPUNGE is counted once (imapflow decrements it itself)', async () => {
  const { client, imap } = selectedInbox(66);
  await imap.untaggedExpunge({ command: '5' });
  assert.equal(cachedExists(client), 65);
});
