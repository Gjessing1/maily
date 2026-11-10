/**
 * Reply/forward quoting. The point of the HTML quote is that our sent mail looks
 * like every other client's: a `blockquote.gmail_quote` with a grey bar, not the
 * literal `&gt;` lines an escaped plain-text quote produced. These tests pin both
 * halves of that — the markup we emit, and the `>` text alternative derived from it.
 */
import { describe, expect, test } from 'vitest';
import type { MessageDetailDto } from '@maily/shared';
import { buildForward, buildReply, composeLinkPrefill } from './replyPrefill';
import { htmlToPlainText } from '../ui/htmlText';
import { splitQuotedHtml } from '../ui/quote';

const detail: MessageDetailDto = {
  id: 'm1',
  accountId: 'a1',
  threadId: 't1',
  subject: 'Tilbud 908094',
  fromName: 'Tore',
  fromAddress: 'tore@example.test',
  to: [{ name: null, address: 'lars@example.test' }],
  snippet: null,
  sentAt: '2026-05-20T14:50:00.000Z',
  receivedAt: '2026-05-20T14:50:01.000Z',
  seen: true,
  flagged: false,
  localOnly: false,
  folderIds: ['f1'],
  attachments: [],
  messageId: '<abc@example.test>',
  bodyText: 'Kan du bekrefte adressen?\n\nTakk!',
  bodyHtml: null,
  inReplyTo: null,
  references: null,
  cc: [],
};

describe('buildReply', () => {
  test('quotes as a gmail_quote blockquote, not > lines', () => {
    const { quoteHtml } = buildReply(detail);
    expect(quoteHtml).toContain('<blockquote class="gmail_quote"');
    expect(quoteHtml).toContain('border-left:1px #ccc solid');
    expect(quoteHtml).toContain('Kan du bekrefte adressen?');
    expect(quoteHtml).not.toContain('&gt;');
  });

  test('the sender HTML body is never spliced into the quote', () => {
    const evil = { ...detail, bodyHtml: '<img src=x onerror="alert(1)">' };
    expect(buildReply(evil).quoteHtml).not.toContain('onerror');
  });

  test('derives a >-quoted text/plain alternative', () => {
    const text = htmlToPlainText(buildReply(detail).quoteHtml ?? '');
    expect(text).toContain('Tore wrote:');
    expect(text).toContain('> Kan du bekrefte adressen?');
    expect(text).toContain('> Takk!');
  });

  test('the reader collapses our own quote', () => {
    const sent = `<div>Ja, det stemmer.</div><div><br></div>${buildReply(detail).quoteHtml}`;
    const { visible, quoted } = splitQuotedHtml(sent);
    expect(visible).toContain('Ja, det stemmer.');
    expect(visible).not.toContain('Kan du bekrefte');
    expect(quoted).toContain('Tore wrote:');
    expect(quoted).toContain('Kan du bekrefte adressen?');
  });
});

describe('buildForward', () => {
  test('wraps the forwarded message without indenting it', () => {
    const { quoteHtml } = buildForward(detail);
    expect(quoteHtml).toContain('<div class="gmail_quote">');
    expect(quoteHtml).not.toContain('<blockquote');
    expect(quoteHtml).toContain('Forwarded message');
    expect(quoteHtml).toContain('Kan du bekrefte adressen?');
  });
});

/**
 * The composer's URL is the only way in from outside the app — the `mailto:` protocol
 * handler, the share target, and the Android shell's intents all arrive through it.
 */
describe('composeLinkPrefill', () => {
  const prefill = (query: string) => composeLinkPrefill(new URLSearchParams(query));

  test('leaves an ordinary /compose alone', () => {
    expect(prefill('')).toBeNull();
    expect(prefill('handoff=abc')).toBeNull();
  });

  test('unpacks a mailto: link the browser or the shell substituted in', () => {
    const link =
      'mailto:a@example.com,b@example.com?cc=c@example.com&subject=Hi%20there&body=One%0ATwo';
    expect(prefill(`mailto=${encodeURIComponent(link)}`)).toEqual({
      accountId: undefined,
      to: ['a@example.com', 'b@example.com'],
      cc: ['c@example.com'],
      subject: 'Hi there',
      body: 'One\nTwo',
    });
  });

  test('refuses a mailto parameter that is not a mailto: URL', () => {
    expect(prefill(`mailto=${encodeURIComponent('javascript:alert(1)')}`)).toBeNull();
  });

  test('maps a share to subject and body', () => {
    expect(prefill('title=A%20page&text=Worth%20reading&url=https%3A%2F%2Fexample.com')).toEqual({
      subject: 'A page',
      body: 'Worth reading\n\nhttps://example.com',
    });
  });

  test('does not repeat a link the shared text already contains', () => {
    expect(prefill('text=See%20https%3A%2F%2Fexample.com&url=https%3A%2F%2Fexample.com')).toEqual({
      body: 'See https://example.com',
    });
  });
});
