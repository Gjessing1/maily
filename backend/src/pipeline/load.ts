/**
 * Load a message's parsed-stage view for enrichment. Pure read over derived columns
 * (ARCHITECTURE §15) — never touches mailbox state.
 */
import { eq } from 'drizzle-orm';
import type { EmailAddress } from '@maily/shared';
import { db } from '../db/client.js';
import { messages } from '../db/schema.js';
import type { PipelineMessage } from './types.js';

function parseAddresses(json: string | null): EmailAddress[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as EmailAddress[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Build the `PipelineMessage` view for an id, or null if the row is gone. */
export function loadPipelineMessage(id: string): PipelineMessage | null {
  const row = db
    .select({
      id: messages.id,
      accountId: messages.accountId,
      threadId: messages.threadId,
      subject: messages.subject,
      fromName: messages.fromName,
      fromAddress: messages.fromAddress,
      toAddresses: messages.toAddresses,
      ccAddresses: messages.ccAddresses,
      snippet: messages.snippet,
      bodyText: messages.bodyText,
      bodyHtml: messages.bodyHtml,
      bodyCalendar: messages.bodyCalendar,
      inReplyTo: messages.inReplyTo,
      references: messages.references,
      sentAt: messages.sentAt,
      receivedAt: messages.receivedAt,
      sourcePath: messages.sourcePath,
    })
    .from(messages)
    .where(eq(messages.id, id))
    .get();
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.accountId,
    threadId: row.threadId,
    subject: row.subject,
    fromName: row.fromName,
    fromAddress: row.fromAddress,
    to: parseAddresses(row.toAddresses),
    cc: parseAddresses(row.ccAddresses),
    snippet: row.snippet,
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
    bodyCalendar: row.bodyCalendar,
    inReplyTo: row.inReplyTo,
    references: row.references,
    sentAt: row.sentAt,
    receivedAt: row.receivedAt,
    sourcePath: row.sourcePath,
  };
}
