/**
 * Mail-derived contact intelligence (ROADMAP A3). CardDAV remains the source of
 * contact data; this read model only projects messages already cached in SQLite.
 */
import { sql, type SQL } from 'drizzle-orm';
import type {
  ContactAttachmentActivityDto,
  ContactCommunicationDto,
  ContactEmailIntelligenceDto,
} from '@maily/shared';
import { db } from '../db/client.js';

const TIMELINE_LIMIT = 40;
const ATTACHMENT_LIMIT = 12;

interface Predicates {
  inbound: SQL;
  outbound: SQL;
  communication: SQL;
}

/** Exact, case-insensitive address predicates for the SQL alias `m`. */
function predicatesFor(addresses: string[]): Predicates | null {
  const emails = [...new Set(addresses.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (emails.length === 0) return null;
  const list = sql.join(
    emails.map((email) => sql`${email}`),
    sql`, `,
  );
  const inbound = sql`lower(m.from_address) IN (${list})`;
  // Address arrays are JSON columns. json_valid keeps legacy/corrupt rows from
  // aborting the whole contact page, while json_each gives exact address matches
  // instead of a substring over serialized JSON.
  const recipient = sql`(
    EXISTS (
      SELECT 1 FROM json_each(
        CASE WHEN json_valid(m.to_addresses) THEN m.to_addresses ELSE '[]' END
      ) recipient
      WHERE lower(json_extract(recipient.value, '$.address')) IN (${list})
    ) OR EXISTS (
      SELECT 1 FROM json_each(
        CASE WHEN json_valid(m.cc_addresses) THEN m.cc_addresses ELSE '[]' END
      ) recipient
      WHERE lower(json_extract(recipient.value, '$.address')) IN (${list})
    )
  )`;
  // A recipient match is outbound only when it was actually sent by the local
  // account (including aliases filed in Sent). This avoids counting unrelated
  // group/CC traffic merely because the contact also received it.
  const sentByUser = sql`(
    EXISTS (
      SELECT 1 FROM accounts own
      WHERE own.id = m.account_id AND lower(own.email) = lower(m.from_address)
    ) OR EXISTS (
      SELECT 1 FROM message_folders mf
      JOIN folders f ON f.id = mf.folder_id
      WHERE mf.message_id = m.id AND f.role = 'sent'
    )
  )`;
  const outbound = sql`(${recipient} AND ${sentByUser})`;
  return { inbound, outbound, communication: sql`(${inbound} OR ${outbound})` };
}

function toIso(value: number | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

interface SummaryRow {
  message_count: number;
  conversation_count: number;
  first_communication_at: number | null;
  last_received_at: number | null;
  last_sent_at: number | null;
}

interface TimelineRow {
  message_id: string;
  account_id: string;
  thread_id: string | null;
  subject: string | null;
  snippet: string | null;
  occurred_at: number | null;
  direction: 'received' | 'sent';
  attachment_count: number;
}

interface AttachmentActivityRow {
  message_id: string;
  subject: string | null;
  occurred_at: number | null;
  direction: 'received' | 'sent';
  attachment_id: string;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  is_inline: number;
  storage_path: string | null;
}

/** Build the complete, passive contact activity projection. */
export function contactEmailIntelligence(addresses: string[]): ContactEmailIntelligenceDto {
  const predicates = predicatesFor(addresses);
  if (!predicates) {
    return {
      messageCount: 0,
      conversationCount: 0,
      firstCommunicationAt: null,
      lastReceivedAt: null,
      lastSentAt: null,
      timeline: [],
      recentAttachments: [],
    };
  }

  const visible = sql`m.deleted_at IS NULL AND m.purged_at IS NULL`;
  const occurred = sql`CASE
    WHEN ${predicates.inbound} THEN coalesce(m.received_at, m.sent_at)
    ELSE coalesce(m.sent_at, m.received_at)
  END`;

  const summary = db.get(sql`
    SELECT
      count(*) AS message_count,
      count(DISTINCT m.account_id || ':' || coalesce(m.thread_id, 'm:' || m.id))
        AS conversation_count,
      min(${occurred}) AS first_communication_at,
      max(CASE WHEN ${predicates.inbound} THEN coalesce(m.received_at, m.sent_at) END)
        AS last_received_at,
      max(CASE WHEN NOT (${predicates.inbound}) AND ${predicates.outbound}
        THEN coalesce(m.sent_at, m.received_at) END) AS last_sent_at
    FROM messages m
    WHERE ${visible} AND ${predicates.communication}
  `) as SummaryRow | undefined;

  const timelineRows = db.all(sql`
    SELECT
      m.id AS message_id,
      m.account_id AS account_id,
      m.thread_id AS thread_id,
      m.subject AS subject,
      m.snippet AS snippet,
      ${occurred} AS occurred_at,
      CASE WHEN ${predicates.inbound} THEN 'received' ELSE 'sent' END AS direction,
      (SELECT count(*) FROM attachments a
        WHERE a.message_id = m.id AND a.is_inline = 0) AS attachment_count
    FROM messages m
    WHERE ${visible} AND ${predicates.communication}
    ORDER BY occurred_at DESC, m.id
    LIMIT ${TIMELINE_LIMIT}
  `) as TimelineRow[];

  const attachmentRows = db.all(sql`
    SELECT
      m.id AS message_id,
      m.subject AS subject,
      ${occurred} AS occurred_at,
      CASE WHEN ${predicates.inbound} THEN 'received' ELSE 'sent' END AS direction,
      a.id AS attachment_id,
      a.filename AS filename,
      a.mime_type AS mime_type,
      a.size_bytes AS size_bytes,
      a.is_inline AS is_inline,
      a.storage_path AS storage_path
    FROM messages m
    JOIN attachments a ON a.message_id = m.id
    WHERE ${visible} AND ${predicates.communication} AND a.is_inline = 0
    ORDER BY occurred_at DESC, a.created_at DESC, a.id
    LIMIT ${ATTACHMENT_LIMIT}
  `) as AttachmentActivityRow[];

  const timeline: ContactCommunicationDto[] = timelineRows.map((row) => ({
    messageId: row.message_id,
    accountId: row.account_id,
    threadId: row.thread_id,
    subject: row.subject,
    snippet: row.snippet,
    occurredAt: toIso(row.occurred_at),
    direction: row.direction,
    attachmentCount: row.attachment_count,
  }));
  const recentAttachments: ContactAttachmentActivityDto[] = attachmentRows.map((row) => ({
    messageId: row.message_id,
    subject: row.subject,
    occurredAt: toIso(row.occurred_at),
    direction: row.direction,
    attachment: {
      id: row.attachment_id,
      filename: row.filename,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      isInline: row.is_inline !== 0,
      downloaded: row.storage_path !== null,
    },
  }));

  return {
    messageCount: summary?.message_count ?? 0,
    conversationCount: summary?.conversation_count ?? 0,
    firstCommunicationAt: toIso(summary?.first_communication_at ?? null),
    lastReceivedAt: toIso(summary?.last_received_at ?? null),
    lastSentAt: toIso(summary?.last_sent_at ?? null),
    timeline,
    recentAttachments,
  };
}
