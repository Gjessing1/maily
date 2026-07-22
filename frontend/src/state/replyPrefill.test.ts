/**
 * Reply/forward quoting. The point of the HTML quote is that our sent mail looks
 * like every other client's: a `blockquote.gmail_quote` with a grey bar, not the
 * literal `&gt;` lines an escaped plain-text quote produced. These tests pin both
 * halves of that — the markup we emit, and the `>` text alternative derived from it.
 */
import { describe, expect, test } from 'vitest';
import type { MessageDetailDto } from '@maily/shared';
import { buildForward, buildReply } from './replyPrefill';
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
