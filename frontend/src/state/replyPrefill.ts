/**
 * Builders that turn a loaded message into a Compose prefill for reply / reply-all
 * / forward. Shared by the reader's action bar and the inbox right-click context
 * menu so quoting, subject prefixing, and reply-all address de-duping behave
 * identically wherever the action is triggered.
 */
import type { AccountDto, MessageDetailDto } from '@maily/shared';
import { fullDate, senderName } from '../ui/format';
import { escapeHtml } from '../ui/htmlText';
import { parseMailto, type MailtoLink } from '../ui/mailLink';
import type { ComposeAttachment, ComposePrefill } from '../routes/Compose';

/**
 * Inline style Gmail puts on its quote blockquote. Mail clients strip <style>
 * blocks and know nothing of our classes, so the grey left bar has to ride along
 * as an inline style or the quote renders flat everywhere but here.
 */
const QUOTE_STYLE = 'margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex;color:#5f6368';

/** Escaped plain text as HTML lines (blank lines survive as empty <div>s). */
function textToLines(text: string): string {
  return text
    .split('\n')
    .map((l) => `<div>${escapeHtml(l) || '<br>'}</div>`)
    .join('');
}

function attribution(detail: MessageDetailDto): string {
  return `On ${fullDate(detail.sentAt ?? detail.receivedAt)}, ${senderName(
    detail.fromName,
    detail.fromAddress,
  )} wrote:`;
}

/**
 * The quoted history as real HTML: a `gmail_attr` attribution line above a
 * `blockquote.gmail_quote`, i.e. what Gmail/Apple Mail emit and what every client
 * (including our own reader, see ui/quote.ts) recognises as history. We quote the
 * source's *text* body, never its HTML — sender markup must not be spliced into
 * our contentEditable, where it would escape the reader's sandboxed iframe.
 *
 * The `>` prefixes that belong in the text/plain alternative are not baked in
 * here; htmlToPlainText derives them from the blockquote at send time.
 */
function quotedReplyHtml(detail: MessageDetailDto): string | undefined {
  if (!detail.bodyText) return undefined;
  return (
    `<div class="gmail_quote">` +
    `<div class="gmail_attr">${escapeHtml(attribution(detail))}</div>` +
    `<blockquote class="gmail_quote" style="${QUOTE_STYLE}">` +
    textToLines(detail.bodyText) +
    `</blockquote></div>`
  );
}

/** Plain-text quote, kept for consumers that only deal in text (drafts, tests). */
function quotedReply(detail: MessageDetailDto): string {
  if (!detail.bodyText) return '';
  const body = detail.bodyText
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  return `\n\n${attribution(detail)}\n${body}`;
}

function replyCommon(detail: MessageDetailDto): ComposePrefill {
  const subject = detail.subject ?? '';
  return {
    accountId: detail.accountId,
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    body: quotedReply(detail),
    quoteHtml: quotedReplyHtml(detail),
    inReplyTo: detail.messageId,
    references: [detail.references, detail.messageId].filter(Boolean).join(' ') || null,
  };
}

/** Dedup (case-insensitive), preserving order and dropping excluded addresses. */
function pickAddrs(addrs: string[], exclude: Set<string>): string[] {
  const seen = new Set(exclude);
  const out: string[] = [];
  for (const a of addrs) {
    const key = a.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

export function buildReply(detail: MessageDetailDto): ComposePrefill {
  return { ...replyCommon(detail), to: detail.fromAddress ? [detail.fromAddress] : [] };
}

export function buildReplyAll(detail: MessageDetailDto, accounts: AccountDto[]): ComposePrefill {
  // Addresses belonging to us — excluded so we don't reply to ourselves.
  const own = new Set(accounts.map((a) => a.email.toLowerCase()));
  const to = pickAddrs(
    [detail.fromAddress ?? '', ...detail.to.map((a) => a.address)].filter(Boolean),
    own,
  );
  // Cc carries the remaining recipients, minus anyone already in To.
  const cc = pickAddrs(
    detail.cc.map((a) => a.address),
    new Set([...own, ...to.map((a) => a.toLowerCase())]),
  );
  return { ...replyCommon(detail), to, cc };
}

/**
 * Compose prefill for a `mailto:` link tapped inside a message body — maily answers
 * those itself rather than handing the address to a foreign mail app. `accountId` is
 * the account the message arrived on, so the reply goes out from the same address.
 */
export function buildMailto(link: MailtoLink, accountId?: string): ComposePrefill {
  return {
    accountId,
    to: link.to,
    cc: link.cc,
    subject: link.subject,
    body: link.body,
  };
}

/**
 * Compose prefill carried in the composer's own URL — how anything outside the app
 * starts a message, since router state cannot cross a page load:
 *
 * - `?mailto=<mailto: URL>` — the manifest's `protocol_handlers` entry (the browser
 *   substitutes the tapped link) and the Android shell's `mailto:` intents.
 * - `?title=&text=&url=` — the manifest's `share_target` (Web Share Target, GET).
 *
 * Null when the URL carries neither, so an ordinary `/compose` is left alone. Only ever
 * fills fields for the user to review: nothing here can send.
 */
export function composeLinkPrefill(params: URLSearchParams): ComposePrefill | null {
  const mailto = params.get('mailto');
  if (mailto && /^mailto:/i.test(mailto.trim())) return buildMailto(parseMailto(mailto.trim()));

  const title = params.get('title')?.trim();
  const text = params.get('text')?.trim();
  const url = params.get('url')?.trim();
  if (!title && !text && !url) return null;
  // Android apps routinely put the link in `text` and leave `url` empty; when both
  // arrive, don't repeat a link the text already contains.
  const body = [text, url && !text?.includes(url) ? url : ''].filter(Boolean).join('\n\n');
  return { ...(title ? { subject: title } : {}), ...(body ? { body } : {}) };
}

export function buildForward(detail: MessageDetailDto): ComposePrefill {
  const subject = detail.subject ?? '';
  const header = [
    '---------- Forwarded message ----------',
    `From: ${senderName(detail.fromName, detail.fromAddress)}`,
    `Date: ${fullDate(detail.sentAt ?? detail.receivedAt)}`,
    `Subject: ${subject}`,
    detail.to.length ? `To: ${detail.to.map((a) => a.address).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const attachments: ComposeAttachment[] = detail.attachments
    .filter((a) => !a.isInline)
    .map((a) => ({ messageId: detail.id, attachmentId: a.id, filename: a.filename }));
  // Forwards are wrapped but not indented — Gmail marks them with `gmail_quote`
  // and no blockquote, so the forwarded body keeps its own formatting.
  const quoteHtml =
    `<div class="gmail_quote">` +
    `<div class="gmail_attr">${textToLines(header)}</div>` +
    textToLines(detail.bodyText ?? '') +
    `</div>`;
  return {
    accountId: detail.accountId,
    subject: /^fwd:/i.test(subject) ? subject : `Fwd: ${subject}`,
    body: `\n\n${header}\n\n${detail.bodyText ?? ''}`,
    quoteHtml,
    attachments,
  };
}
