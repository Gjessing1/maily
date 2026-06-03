/**
 * Shared outbound-MIME builder used by both the SMTP send path and the draft
 * (\Drafts APPEND) path. Centralises attachment resolution + MIME assembly so a
 * sent message and a saved draft are composed identically (one Message-ID each).
 */
import { randomUUID } from 'node:crypto';
import type nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { SendMessageRequest } from '@maily/shared';
import type { AccountConfig } from '../config/accounts.js';
import { createLogger } from '../logger.js';
import { getAttachment } from '../db/queries.js';
import { ensureAttachmentOnDisk } from '../storage/attachments.js';
import { openUpload } from '../storage/uploads.js';

const log = createLogger('mail');

/**
 * Resolve send-time attachments to nodemailer attachments: existing stored files
 * (forward — bytes from cache/IMAP) plus freshly staged composer uploads (bytes
 * from the uploads dir). Both reference files on disk, never buffered into memory.
 */
export async function resolveAttachments(
  req: SendMessageRequest,
): Promise<nodemailer.SendMailOptions['attachments']> {
  const out: NonNullable<nodemailer.SendMailOptions['attachments']> = [];

  for (const ref of req.attachments ?? []) {
    const att = getAttachment(ref.attachmentId);
    if (!att || att.messageId !== ref.messageId) {
      log.warn(`skipping unknown attachment ref ${ref.attachmentId}`);
      continue;
    }
    const path = await ensureAttachmentOnDisk(att);
    if (!path) {
      log.warn(`skipping attachment ${ref.attachmentId}: bytes unavailable`);
      continue;
    }
    out.push({
      path,
      filename: att.filename ?? undefined,
      contentType: att.mimeType ?? undefined,
    });
  }

  for (const ref of req.uploads ?? []) {
    const staged = openUpload(ref.uploadId);
    if (!staged) {
      log.warn(`skipping unknown upload ${ref.uploadId}`);
      continue;
    }
    out.push({
      path: staged.path,
      filename: ref.filename || undefined,
      contentType: ref.mimeType ?? undefined,
    });
  }

  return out.length ? out : undefined;
}

export interface BuiltMime {
  raw: Buffer;
  messageId: string;
}

/** Build the raw RFC822 message (with a fresh Message-ID) for a compose request. */
export async function buildMime(
  config: AccountConfig,
  req: SendMessageRequest,
): Promise<BuiltMime> {
  const domain = config.email.split('@')[1] ?? 'localhost';
  const messageId = `<${randomUUID()}@${domain}>`;

  const mailOptions: nodemailer.SendMailOptions = {
    from: { name: config.displayName ?? config.email, address: config.email },
    to: req.to,
    cc: req.cc,
    bcc: req.bcc,
    subject: req.subject,
    text: req.text,
    html: req.html,
    inReplyTo: req.inReplyTo ?? undefined,
    references: req.references ?? undefined,
    attachments: await resolveAttachments(req),
    messageId,
  };

  const raw = await new MailComposer(mailOptions).compile().build();
  return { raw, messageId };
}
