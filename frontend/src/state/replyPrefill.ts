/**
 * Builders that turn a loaded message into a Compose prefill for reply / reply-all
 * / forward. Shared by the reader's action bar and the inbox right-click context
 * menu so quoting, subject prefixing, and reply-all address de-duping behave
 * identically wherever the action is triggered.
 */
import type { AccountDto, MessageDetailDto } from '@maily/shared';
import { fullDate, senderName } from '../ui/format';
import type { ComposeAttachment, ComposePrefill } from '../routes/Compose';

function quotedReply(detail: MessageDetailDto): string {
  if (!detail.bodyText) return '';
  const lead = `On ${fullDate(detail.sentAt ?? detail.receivedAt)}, ${senderName(
    detail.fromName,
    detail.fromAddress,
  )} wrote:`;
  const body = detail.bodyText
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  return `\n\n${lead}\n${body}`;
}

function replyCommon(detail: MessageDetailDto): ComposePrefill {
  const subject = detail.subject ?? '';
  return {
    accountId: detail.accountId,
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    body: quotedReply(detail),
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
  return {
    accountId: detail.accountId,
    subject: /^fwd:/i.test(subject) ? subject : `Fwd: ${subject}`,
    body: `\n\n${header}\n\n${detail.bodyText ?? ''}`,
    attachments,
  };
}
