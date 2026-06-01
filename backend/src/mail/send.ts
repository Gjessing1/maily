/**
 * Outgoing mail: SMTP send via nodemailer, then provider-aware APPEND to \Sent.
 *
 * KEY GOTCHA / ARCHITECTURE §10: Gmail already files SMTP-sent mail into its Sent
 * label server-side, so APPENDing there would duplicate every sent message. We
 * APPEND only on providers that don't (mailbox.org, generic IMAP). The exact same
 * raw MIME (one Message-ID) is both sent and appended.
 */
import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { ImapFlow } from 'imapflow';
import type { SendMessageRequest } from '@maily/shared';
import type { AccountConfig } from '../config/accounts.js';
import { createLogger } from '../logger.js';
import { withTransientConnection } from '../imap/connection.js';

const log = createLogger('smtp');

/** Locate the \Sent mailbox path for an account, if the server exposes one. */
async function findSentMailbox(client: ImapFlow): Promise<string | null> {
  const list = await client.list();
  const bySpecialUse = list.find((b) => b.specialUse === '\\Sent');
  if (bySpecialUse) return bySpecialUse.path;
  const byName = list.find((b) => /^sent\b/i.test(b.name) || /sent mail/i.test(b.name));
  return byName?.path ?? null;
}

export interface SendResult {
  messageId: string;
  appendedToSent: boolean;
}

export async function sendMessage(
  config: AccountConfig,
  req: SendMessageRequest,
): Promise<SendResult> {
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
    messageId,
  };

  // Build the raw MIME once so the sent copy and the appended copy are identical.
  const raw = await new MailComposer(mailOptions).compile().build();

  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });

  const recipients = [...(req.to ?? []), ...(req.cc ?? []), ...(req.bcc ?? [])];
  await transport.sendMail({ envelope: { from: config.email, to: recipients }, raw });

  let appendedToSent = false;
  if (config.provider !== 'gmail') {
    try {
      await withTransientConnection(config, async (client) => {
        const sent = await findSentMailbox(client);
        if (sent) {
          await client.append(sent, raw, ['\\Seen']);
          appendedToSent = true;
        } else {
          log.warn(`no \\Sent mailbox found for ${config.email}; skipping APPEND`);
        }
      });
    } catch (err) {
      log.warn(`APPEND to Sent failed for ${config.email}:`, (err as Error).message);
    }
  }

  return { messageId, appendedToSent };
}
